import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Modal,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useFeed } from '../context/FeedContext';
import { getComments, postComment, deleteComment } from '../services/api';
import AuthModal from './AuthModal';

export default function CommentsModal({ visible, onClose, postId }) {
  const insets = useSafeAreaInsets();
  const { isAuthenticated, user } = useAuth();
  const { updateCommentCount } = useFeed();

  const [comments, setComments] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [text, setText] = useState('');
  const [replyingTo, setReplyingTo] = useState(null); // { id, display_name }
  const [authModalVisible, setAuthModalVisible] = useState(false);
  const inputRef = useRef(null);

  // Load comments when modal opens
  useEffect(() => {
    if (visible && postId) {
      loadComments();
    }
    if (!visible) {
      setComments([]);
      setTotal(0);
      setReplyingTo(null);
      setText('');
    }
  }, [visible, postId]);

  const loadComments = useCallback(async () => {
    if (!postId) return;
    setLoading(true);
    try {
      const data = await getComments(postId, 50, 0);
      setComments(data.comments);
      setTotal(data.total);
    } catch {
      // Silently fail — user can see empty state
    } finally {
      setLoading(false);
    }
  }, [postId]);

  // Flatten comments + replies for FlatList
  const flattenedData = React.useMemo(() => {
    const result = [];
    for (const comment of comments) {
      result.push({ ...comment, isReply: false });
      if (comment.replies) {
        for (const reply of comment.replies) {
          result.push({ ...reply, isReply: true });
        }
      }
    }
    return result;
  }, [comments]);

  const handlePost = useCallback(async () => {
    if (!isAuthenticated) {
      setAuthModalVisible(true);
      return;
    }

    const body = text.trim();
    if (!body) return;

    setSubmitting(true);
    const parentId = replyingTo?.id ?? null;

    // Optimistic add
    const tempId = `temp-${Date.now()}`;
    const optimisticComment = {
      id: tempId,
      post_id: postId,
      user_id: user?.id,
      parent_id: parentId,
      display_name: user?.display_name || user?.email?.split('@')[0] || 'You',
      body,
      created_at: new Date().toISOString(),
      replies: [],
      reply_count: 0,
    };

    if (parentId) {
      // Add as reply under the parent
      setComments((prev) =>
        prev.map((c) =>
          c.id === parentId
            ? { ...c, replies: [...(c.replies || []), optimisticComment], reply_count: (c.reply_count || 0) + 1 }
            : c
        )
      );
    } else {
      setComments((prev) => [...prev, optimisticComment]);
      setTotal((prev) => prev + 1);
    }

    setText('');
    setReplyingTo(null);
    updateCommentCount(postId, 1);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    try {
      const created = await postComment(postId, body, parentId);
      // Replace temp with real comment
      if (parentId) {
        setComments((prev) =>
          prev.map((c) =>
            c.id === parentId
              ? { ...c, replies: (c.replies || []).map((r) => (r.id === tempId ? created : r)) }
              : c
          )
        );
      } else {
        setComments((prev) => prev.map((c) => (c.id === tempId ? { ...created, replies: [], reply_count: 0 } : c)));
      }
    } catch {
      // Rollback optimistic add
      if (parentId) {
        setComments((prev) =>
          prev.map((c) =>
            c.id === parentId
              ? { ...c, replies: (c.replies || []).filter((r) => r.id !== tempId), reply_count: Math.max(0, (c.reply_count || 0) - 1) }
              : c
          )
        );
      } else {
        setComments((prev) => prev.filter((c) => c.id !== tempId));
        setTotal((prev) => Math.max(0, prev - 1));
      }
      updateCommentCount(postId, -1);
      Alert.alert('Error', 'Failed to post comment');
    } finally {
      setSubmitting(false);
    }
  }, [isAuthenticated, text, replyingTo, postId, user, updateCommentCount]);

  const handleDelete = useCallback(
    async (commentId, parentId) => {
      // Count how many will be deleted (comment + its replies if top-level)
      let deletedCount = 1;
      if (!parentId) {
        const parent = comments.find((c) => c.id === commentId);
        if (parent) deletedCount += (parent.replies?.length || 0);
      }

      // Optimistic remove
      if (parentId) {
        setComments((prev) =>
          prev.map((c) =>
            c.id === parentId
              ? { ...c, replies: (c.replies || []).filter((r) => r.id !== commentId), reply_count: Math.max(0, (c.reply_count || 0) - 1) }
              : c
          )
        );
      } else {
        setComments((prev) => prev.filter((c) => c.id !== commentId));
        setTotal((prev) => Math.max(0, prev - 1));
      }

      updateCommentCount(postId, -deletedCount);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      try {
        await deleteComment(postId, commentId);
      } catch {
        // Rollback — just reload
        loadComments();
        updateCommentCount(postId, deletedCount);
      }
    },
    [postId, comments, updateCommentCount, loadComments]
  );

  const handleReply = useCallback((comment) => {
    setReplyingTo({ id: comment.parent_id || comment.id, display_name: comment.display_name });
    inputRef.current?.focus();
  }, []);

  const renderItem = useCallback(
    ({ item }) => {
      const isOwn = user?.id === item.user_id;
      const displayName = item.display_name || 'Anonymous';
      const initial = displayName.charAt(0).toUpperCase();

      return (
        <View style={[styles.commentRow, item.isReply && styles.replyRow]}>
          <View style={[styles.avatar, item.isReply && styles.avatarSmall]}>
            <Text style={[styles.avatarText, item.isReply && styles.avatarTextSmall]}>{initial}</Text>
          </View>
          <View style={styles.commentContent}>
            <View style={styles.commentHeader}>
              <Text style={styles.commentAuthor}>{displayName}</Text>
              <Text style={styles.commentTime}>{timeAgo(item.created_at)}</Text>
            </View>
            <Text style={styles.commentBody}>{item.body}</Text>
            <View style={styles.commentActions}>
              <TouchableOpacity onPress={() => handleReply(item)} activeOpacity={0.7}>
                <Text style={styles.actionText}>Reply</Text>
              </TouchableOpacity>
              {isOwn && (
                <TouchableOpacity onPress={() => handleDelete(item.id, item.isReply ? item.parent_id : null)} activeOpacity={0.7}>
                  <Text style={[styles.actionText, styles.deleteText]}>Delete</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      );
    },
    [user, handleReply, handleDelete]
  );

  const keyExtractor = useCallback((item, index) => item.id + (item.isReply ? '-reply' : '') + index, []);

  return (
    <>
      <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
        <View style={[styles.container, { paddingBottom: insets.bottom }]}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Comments{total > 0 ? ` (${total})` : ''}</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Ionicons name="close" size={24} color="#94a3b8" />
            </TouchableOpacity>
          </View>

          {/* Comments list */}
          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator color="#3b82f6" />
            </View>
          ) : (
            <FlatList
              data={flattenedData}
              renderItem={renderItem}
              keyExtractor={keyExtractor}
              contentContainerStyle={[
                styles.listContent,
                flattenedData.length === 0 && styles.emptyListContent,
              ]}
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <Ionicons name="chatbubble-outline" size={40} color="#334155" />
                  <Text style={styles.emptyText}>No comments yet</Text>
                  <Text style={styles.emptySubtext}>Be the first to comment</Text>
                </View>
              }
              keyboardShouldPersistTaps="handled"
            />
          )}

          {/* Input bar */}
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
          >
            {replyingTo && (
              <View style={styles.replyBanner}>
                <Text style={styles.replyBannerText}>
                  Replying to <Text style={styles.replyBannerName}>{replyingTo.display_name || 'Anonymous'}</Text>
                </Text>
                <TouchableOpacity onPress={() => setReplyingTo(null)}>
                  <Ionicons name="close-circle" size={18} color="#64748b" />
                </TouchableOpacity>
              </View>
            )}
            <View style={styles.inputBar}>
              <TextInput
                ref={inputRef}
                style={styles.input}
                placeholder={isAuthenticated ? 'Add a comment...' : 'Sign in to comment'}
                placeholderTextColor="#64748b"
                value={text}
                onChangeText={setText}
                multiline
                maxLength={1000}
                editable={!submitting}
              />
              <TouchableOpacity
                style={[styles.sendButton, (!text.trim() || submitting) && styles.sendButtonDisabled]}
                onPress={handlePost}
                disabled={!text.trim() || submitting}
                activeOpacity={0.7}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="send" size={18} color="#fff" />
                )}
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>

      {/* Nested auth modal */}
      <AuthModal visible={authModalVisible} onClose={() => setAuthModalVisible(false)} />
    </>
  );
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0f1a',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  headerTitle: {
    color: '#f1f5f9',
    fontSize: 17,
    fontWeight: '600',
  },
  closeButton: {
    position: 'absolute',
    right: 16,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    paddingVertical: 8,
  },
  emptyListContent: {
    flex: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyText: {
    color: '#94a3b8',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 12,
  },
  emptySubtext: {
    color: '#475569',
    fontSize: 14,
    marginTop: 4,
  },

  /* Comment rows */
  commentRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  replyRow: {
    paddingLeft: 56,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#1e293b',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  avatarSmall: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  avatarText: {
    color: '#94a3b8',
    fontSize: 14,
    fontWeight: '700',
  },
  avatarTextSmall: {
    fontSize: 12,
  },
  commentContent: {
    flex: 1,
  },
  commentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  commentAuthor: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '600',
    marginRight: 8,
  },
  commentTime: {
    color: '#475569',
    fontSize: 12,
  },
  commentBody: {
    color: '#cbd5e1',
    fontSize: 14,
    lineHeight: 20,
  },
  commentActions: {
    flexDirection: 'row',
    marginTop: 6,
    gap: 16,
  },
  actionText: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '600',
  },
  deleteText: {
    color: '#ef4444',
  },

  /* Reply banner */
  replyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#151a24',
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  replyBannerText: {
    color: '#94a3b8',
    fontSize: 13,
  },
  replyBannerName: {
    color: '#e2e8f0',
    fontWeight: '600',
  },

  /* Input bar */
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    backgroundColor: '#0b0f1a',
  },
  input: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: '#f1f5f9',
    fontSize: 15,
    maxHeight: 100,
    marginRight: 8,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#2563eb',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#334155',
  },
});
