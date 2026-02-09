import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Dimensions,
  ActivityIndicator,
  Animated,
  BackHandler,
  RefreshControl,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../context/AuthContext';
import { getMyPosts, likeSplat, unlikeSplat } from '../services/api';
import { RENDERER_URL } from '../config';
import AuthModal from '../components/AuthModal';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const GRID_GAP = 2;
const NUM_COLUMNS = 3;
const CELL_SIZE = (SCREEN_WIDTH - GRID_GAP * (NUM_COLUMNS - 1)) / NUM_COLUMNS;

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

const INJECTED_JS = `
(function(){
  var sy=0,sx=0,st=0,lt=0;
  document.addEventListener('touchstart',function(e){
    if(e.touches.length===1){sy=e.touches[0].clientY;sx=e.touches[0].clientX;st=Date.now();}
  },{passive:true});
  document.addEventListener('touchend',function(e){
    if(e.changedTouches.length!==1)return;
    var dy=e.changedTouches[0].clientY-sy;
    var dx=e.changedTouches[0].clientX-sx;
    var dt=Date.now()-st;
    var now=Date.now();
    if(now-lt<300&&dt<200&&Math.abs(dy)<10&&Math.abs(dx)<10){
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'doubleTap'}));
      lt=0;
    }else{lt=now;}
  },{passive:true});
})();true;
`;

export default function ProfileScreen() {
  const { user, isAuthenticated, logout } = useAuth();
  const insets = useSafeAreaInsets();
  const [showAuth, setShowAuth] = useState(false);
  const [posts, setPosts] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Detail overlay state
  const [detailItem, setDetailItem] = useState(null);
  const detailTranslateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const [heartVisible, setHeartVisible] = useState(false);
  const heartScale = useRef(new Animated.Value(0)).current;
  const heartOpacity = useRef(new Animated.Value(0)).current;

  const providerLabel = isAuthenticated
    ? ({ email: 'Email', google: 'Google', apple: 'Apple' }[user.provider] || user.provider)
    : null;

  const fetchPosts = useCallback(async (reset = true) => {
    if (!isAuthenticated) return;
    if (reset) setRefreshing(true);
    else setLoading(true);
    try {
      const offset = reset ? 0 : posts.length;
      const data = await getMyPosts(30, offset);
      if (reset) {
        setPosts(data.items);
      } else {
        setPosts((prev) => [...prev, ...data.items]);
      }
      setTotal(data.total);
    } catch {
      // Silently fail — user can pull to refresh
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isAuthenticated, posts.length]);

  useFocusEffect(
    useCallback(() => {
      if (isAuthenticated) fetchPosts(true);
    }, [isAuthenticated])
  );

  // Detail overlay
  const openDetail = useCallback((item) => {
    setDetailItem(item);
    detailTranslateY.setValue(SCREEN_HEIGHT);
    Animated.spring(detailTranslateY, {
      toValue: 0,
      useNativeDriver: true,
      tension: 65,
      friction: 11,
    }).start();
  }, [detailTranslateY]);

  const closeDetail = useCallback(() => {
    Animated.timing(detailTranslateY, {
      toValue: SCREEN_HEIGHT,
      duration: 250,
      useNativeDriver: true,
    }).start(() => setDetailItem(null));
  }, [detailTranslateY]);

  // Android back button for detail
  useFocusEffect(
    useCallback(() => {
      if (!detailItem) return;
      const handler = BackHandler.addEventListener('hardwareBackPress', () => {
        closeDetail();
        return true;
      });
      return () => handler.remove();
    }, [detailItem, closeDetail])
  );

  const handleLike = useCallback(async (postId) => {
    if (!isAuthenticated) {
      setShowAuth(true);
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    const item = posts.find((p) => p.post_id === postId);
    if (!item) return;
    const wasLiked = item.liked_by_me;

    // Optimistic update
    const update = (list) =>
      list.map((p) =>
        p.post_id === postId
          ? {
              ...p,
              liked_by_me: !wasLiked,
              like_count: wasLiked ? Math.max(0, (p.like_count || 0) - 1) : (p.like_count || 0) + 1,
            }
          : p
      );
    setPosts(update);
    if (detailItem?.post_id === postId) {
      setDetailItem((prev) => ({
        ...prev,
        liked_by_me: !wasLiked,
        like_count: wasLiked ? Math.max(0, (prev.like_count || 0) - 1) : (prev.like_count || 0) + 1,
      }));
    }

    try {
      if (wasLiked) await unlikeSplat(postId);
      else await likeSplat(postId);
    } catch {
      // Rollback
      const rollback = (list) =>
        list.map((p) =>
          p.post_id === postId
            ? {
                ...p,
                liked_by_me: wasLiked,
                like_count: wasLiked ? (p.like_count || 0) + 1 : Math.max(0, (p.like_count || 0) - 1),
              }
            : p
        );
      setPosts(rollback);
      if (detailItem?.post_id === postId) {
        setDetailItem((prev) => ({
          ...prev,
          liked_by_me: wasLiked,
          like_count: wasLiked ? (prev.like_count || 0) + 1 : Math.max(0, (prev.like_count || 0) - 1),
        }));
      }
    }
  }, [isAuthenticated, posts, detailItem]);

  const showHeartAnimation = useCallback(() => {
    setHeartVisible(true);
    heartScale.setValue(0);
    heartOpacity.setValue(1);
    Animated.sequence([
      Animated.spring(heartScale, { toValue: 1, useNativeDriver: true, tension: 100, friction: 6 }),
      Animated.delay(400),
      Animated.timing(heartOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(() => setHeartVisible(false));
  }, [heartScale, heartOpacity]);

  const handleWebViewMessage = useCallback((event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'doubleTap' && detailItem && !detailItem.liked_by_me) {
        handleLike(detailItem.post_id);
        showHeartAnimation();
      } else if (data.type === 'doubleTap') {
        showHeartAnimation();
      }
    } catch { /* ignore */ }
  }, [detailItem, handleLike, showHeartAnimation]);

  const renderGridItem = useCallback(({ item }) => (
    <TouchableOpacity
      style={styles.gridCell}
      activeOpacity={0.8}
      onPress={() => openDetail(item)}
    >
      <LinearGradient
        colors={['#1a1f2e', '#0d1117', '#161b22']}
        style={styles.gridCellGradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      >
        <Ionicons name="cube-outline" size={28} color="#334155" />
      </LinearGradient>
      <View style={styles.gridCellOverlay}>
        <View style={styles.gridCellStats}>
          <Ionicons name="heart" size={12} color="#fff" />
          <Text style={styles.gridCellStatText}>{item.like_count || 0}</Text>
          <Ionicons name="eye" size={12} color="#fff" style={{ marginLeft: 8 }} />
          <Text style={styles.gridCellStatText}>{item.view_count || 0}</Text>
        </View>
      </View>
    </TouchableOpacity>
  ), [openDetail]);

  const keyExtractor = useCallback((item) => item.post_id, []);

  const detailUrl = detailItem
    ? `${RENDERER_URL}?url=${encodeURIComponent(detailItem.splat_url)}&feed=1`
    : null;
  const detailLiked = detailItem?.liked_by_me ?? false;

  const ProfileHeader = (
    <View style={styles.header}>
      <View style={styles.avatar}>
        <Ionicons
          name={isAuthenticated ? 'person' : 'person-outline'}
          size={36}
          color={isAuthenticated ? '#64748b' : '#475569'}
        />
      </View>

      {isAuthenticated ? (
        <View style={styles.headerInfo}>
          <Text style={styles.displayName}>{user.display_name || 'User'}</Text>
          <Text style={styles.email}>{user.email}</Text>
          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <Text style={styles.statNumber}>{total}</Text>
              <Text style={styles.statLabel}>Splats</Text>
            </View>
          </View>
        </View>
      ) : (
        <View style={styles.headerInfo}>
          <Text style={styles.displayName}>Not signed in</Text>
          <Text style={styles.subtitle}>Sign in to upload videos and save your likes</Text>
        </View>
      )}
    </View>
  );

  const ActionRow = isAuthenticated ? (
    <View style={styles.actionRow}>
      <View style={styles.providerBadge}>
        <Ionicons
          name={user.provider === 'apple' ? 'logo-apple' : user.provider === 'google' ? 'logo-google' : 'mail-outline'}
          size={14}
          color="#94a3b8"
        />
        <Text style={styles.providerText}>{providerLabel}</Text>
      </View>
      <TouchableOpacity style={styles.signOutButton} onPress={logout} activeOpacity={0.7}>
        <Ionicons name="log-out-outline" size={16} color="#ef4444" />
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>
    </View>
  ) : (
    <View style={styles.actionRow}>
      <TouchableOpacity style={styles.signInButton} onPress={() => setShowAuth(true)}>
        <Text style={styles.signInText}>Sign In / Sign Up</Text>
      </TouchableOpacity>
    </View>
  );

  const ListHeader = (
    <>
      {ProfileHeader}
      {ActionRow}
      {isAuthenticated && posts.length > 0 && (
        <View style={styles.gridSectionHeader}>
          <Text style={styles.gridSectionTitle}>Your Splats</Text>
        </View>
      )}
    </>
  );

  const EmptyComponent = isAuthenticated && !loading && !refreshing ? (
    <View style={styles.emptyContainer}>
      <Ionicons name="cube-outline" size={48} color="#334155" />
      <Text style={styles.emptyText}>No splats yet</Text>
      <Text style={styles.emptySubtext}>Capture a video to create your first splat</Text>
    </View>
  ) : null;

  return (
    <View style={styles.container}>
      <FlatList
        data={isAuthenticated ? posts : []}
        renderItem={renderGridItem}
        keyExtractor={keyExtractor}
        numColumns={NUM_COLUMNS}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={EmptyComponent}
        contentContainerStyle={[styles.listContent, { paddingTop: insets.top }]}
        columnWrapperStyle={posts.length > 0 ? styles.gridRow : undefined}
        showsVerticalScrollIndicator={false}
        onEndReached={() => {
          if (!loading && posts.length < total) fetchPosts(false);
        }}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => fetchPosts(true)}
            tintColor="#3b82f6"
            colors={['#3b82f6']}
          />
        }
        ListFooterComponent={
          loading && posts.length > 0 ? (
            <ActivityIndicator style={{ paddingVertical: 20 }} color="#3b82f6" />
          ) : null
        }
      />

      {/* Detail overlay */}
      {detailItem && (
        <Animated.View
          style={[
            styles.detailOverlay,
            { transform: [{ translateY: detailTranslateY }] },
          ]}
        >
          {detailUrl && (
            <WebView
              source={{ uri: detailUrl }}
              style={styles.detailWebView}
              javaScriptEnabled
              domStorageEnabled
              mixedContentMode="always"
              androidLayerType="hardware"
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction={false}
              originWhitelist={['*']}
              injectedJavaScript={INJECTED_JS}
              onMessage={handleWebViewMessage}
            />
          )}

          <View style={styles.detailUI} pointerEvents="box-none">
            {/* Close button */}
            <TouchableOpacity
              style={[styles.closeButton, { top: insets.top + 12 }]}
              onPress={closeDetail}
              activeOpacity={0.7}
            >
              <Ionicons name="chevron-down" size={26} color="#f1f5f9" />
            </TouchableOpacity>

            {/* Right sidebar */}
            <View style={styles.sidebar}>
              <TouchableOpacity
                style={styles.sidebarItem}
                onPress={() => handleLike(detailItem.post_id)}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={detailLiked ? 'heart' : 'heart-outline'}
                  size={30}
                  color={detailLiked ? '#ef4444' : '#f1f5f9'}
                  style={styles.iconShadow}
                />
                <Text style={[styles.sidebarCount, detailLiked && styles.countLiked]}>
                  {detailItem.like_count || 0}
                </Text>
              </TouchableOpacity>

              <View style={styles.sidebarItem}>
                <Ionicons name="eye-outline" size={28} color="#f1f5f9" style={styles.iconShadow} />
                <Text style={styles.sidebarCount}>{detailItem.view_count || 0}</Text>
              </View>

              <View style={styles.sidebarItem}>
                <Text style={styles.detailTime}>{timeAgo(detailItem.created_at)}</Text>
              </View>
            </View>
          </View>

          {/* Heart animation */}
          {heartVisible && (
            <View style={styles.heartOverlay} pointerEvents="none">
              <Animated.View style={{ opacity: heartOpacity, transform: [{ scale: heartScale }] }}>
                <Ionicons name="heart" size={90} color="#ef4444" style={styles.heartDrop} />
              </Animated.View>
            </View>
          )}
        </Animated.View>
      )}

      <AuthModal visible={showAuth} onClose={() => setShowAuth(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0f1a',
  },
  listContent: {
    paddingBottom: 100,
  },

  /* -- Header -- */
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  headerInfo: {
    flex: 1,
  },
  displayName: {
    color: '#f1f5f9',
    fontSize: 20,
    fontWeight: '700',
  },
  email: {
    color: '#94a3b8',
    fontSize: 14,
    marginTop: 2,
  },
  subtitle: {
    color: '#64748b',
    fontSize: 14,
    marginTop: 4,
  },
  statsRow: {
    flexDirection: 'row',
    marginTop: 10,
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginRight: 20,
  },
  statNumber: {
    color: '#f1f5f9',
    fontSize: 17,
    fontWeight: '700',
    marginRight: 4,
  },
  statLabel: {
    color: '#94a3b8',
    fontSize: 14,
  },

  /* -- Action row -- */
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 16,
    gap: 12,
  },
  providerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    gap: 6,
  },
  providerText: {
    color: '#94a3b8',
    fontSize: 13,
  },
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 'auto',
    gap: 4,
  },
  signOutText: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '600',
  },
  signInButton: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 8,
  },
  signInText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },

  /* -- Grid section -- */
  gridSectionHeader: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1e293b',
  },
  gridSectionTitle: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  gridRow: {
    gap: GRID_GAP,
  },
  gridCell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    marginBottom: GRID_GAP,
  },
  gridCellGradient: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  gridCellOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingVertical: 6,
    paddingHorizontal: 6,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  gridCellStats: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  gridCellStatText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 3,
  },

  /* -- Empty state -- */
  emptyContainer: {
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: 24,
  },
  emptyText: {
    color: '#f1f5f9',
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
  },
  emptySubtext: {
    color: '#64748b',
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },

  /* -- Detail overlay -- */
  detailOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
    zIndex: 100,
  },
  detailWebView: {
    flex: 1,
    backgroundColor: '#000',
  },
  detailUI: {
    ...StyleSheet.absoluteFillObject,
  },
  closeButton: {
    position: 'absolute',
    left: 14,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  sidebar: {
    position: 'absolute',
    right: 10,
    bottom: 32,
    alignItems: 'center',
  },
  sidebarItem: {
    alignItems: 'center',
    marginBottom: 22,
  },
  iconShadow: {
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  sidebarCount: {
    fontSize: 12,
    fontWeight: '700',
    color: '#f1f5f9',
    marginTop: 2,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  countLiked: {
    color: '#ef4444',
  },
  detailTime: {
    fontSize: 12,
    fontWeight: '600',
    color: '#94a3b8',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  heartOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  heartDrop: {
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowOffset: { width: 0, height: 3 },
    textShadowRadius: 10,
  },
});
