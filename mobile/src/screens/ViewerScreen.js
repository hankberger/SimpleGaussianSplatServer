import React, { useRef, useMemo, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { useFocusEffect } from '@react-navigation/native';
import { RENDERER_URL } from '../config';
import { useJob } from '../context/JobContext';
import { useFeed } from '../context/FeedContext';
import ProgressBar from '../components/ProgressBar';

export default function ViewerScreen() {
  const webViewRef = useRef(null);
  const { activeJobId, jobStatus } = useJob();
  const {
    currentItem,
    currentIndex,
    items,
    total,
    loading,
    error,
    loadFeed,
    goNext,
    goPrevious,
    startDwellTimer,
    toggleLike,
    likedIds,
  } = useFeed();

  // Refresh feed when tab gains focus
  useFocusEffect(
    useCallback(() => {
      loadFeed(true);
    }, [loadFeed])
  );

  // Start dwell timer when current item changes
  useEffect(() => {
    if (currentItem) {
      startDwellTimer(currentItem.job_id);
    }
  }, [currentItem, startDwellTimer]);

  const webViewUrl = useMemo(() => {
    // If an active job just completed, show it directly
    if (activeJobId && jobStatus?.status === 'completed') {
      return `${RENDERER_URL}?url=/jobs/${activeJobId}/output.splat&feed=1`;
    }
    // Otherwise show current feed item
    if (currentItem) {
      return `${RENDERER_URL}?url=${encodeURIComponent(currentItem.splat_url)}&feed=1`;
    }
    return null;
  }, [activeJobId, jobStatus?.status, currentItem]);

  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex < items.length - 1;
  const isLiked = currentItem ? likedIds.has(currentItem.job_id) : false;

  if (loading && items.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text style={styles.loadingText}>Loading feed...</Text>
      </View>
    );
  }

  if (error && items.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => loadFeed(true)}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!webViewUrl) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>No splats yet</Text>
        <Text style={styles.emptySubtext}>Capture a video to create your first splat</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ uri: webViewUrl }}
        style={styles.webview}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="always"
        androidLayerType="hardware"
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        originWhitelist={['*']}
      />
      <View style={styles.overlay} pointerEvents="box-none">
        <ProgressBar />

        {items.length > 0 && (
          <View style={styles.navBar} pointerEvents="box-none">
            <TouchableOpacity
              style={[styles.arrowButton, !hasPrevious && styles.arrowButtonDisabled]}
              onPress={goPrevious}
              disabled={!hasPrevious}
            >
              <Text style={[styles.arrowText, !hasPrevious && styles.arrowTextDisabled]}>
                {'\u2039'}
              </Text>
            </TouchableOpacity>

            <View style={styles.centerSection} pointerEvents="box-none">
              <TouchableOpacity
                style={styles.likeButton}
                onPress={() => currentItem && toggleLike(currentItem.job_id)}
                disabled={isLiked}
                activeOpacity={isLiked ? 1 : 0.6}
              >
                <Text style={[styles.heartIcon, isLiked && styles.heartIconLiked]}>
                  {isLiked ? '\u2665' : '\u2661'}
                </Text>
                <Text style={[styles.likeCount, isLiked && styles.likeCountLiked]}>
                  {currentItem?.like_count || 0}
                </Text>
              </TouchableOpacity>
              {currentItem && (
                <Text style={styles.viewCount}>
                  {currentItem.view_count} {currentItem.view_count === 1 ? 'view' : 'views'}
                </Text>
              )}
            </View>

            <TouchableOpacity
              style={[styles.arrowButton, !hasNext && styles.arrowButtonDisabled]}
              onPress={goNext}
              disabled={!hasNext}
            >
              <Text style={[styles.arrowText, !hasNext && styles.arrowTextDisabled]}>
                {'\u203A'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  webview: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  centered: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  loadingText: {
    color: '#94a3b8',
    fontSize: 16,
    marginTop: 12,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryText: {
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: '600',
  },
  emptyText: {
    color: '#f1f5f9',
    fontSize: 20,
    fontWeight: '600',
  },
  emptySubtext: {
    color: '#64748b',
    fontSize: 14,
    marginTop: 8,
  },
  navBar: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  arrowButton: {
    width: 48,
    height: 48,
    borderRadius: 10,
    backgroundColor: 'rgba(11, 15, 26, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  arrowButtonDisabled: {
    opacity: 0.25,
  },
  arrowText: {
    color: '#f1f5f9',
    fontSize: 28,
    fontWeight: '300',
    marginTop: -2,
  },
  arrowTextDisabled: {
    color: '#475569',
  },
  centerSection: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  likeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(11, 15, 26, 0.85)',
  },
  heartIcon: {
    fontSize: 22,
    color: '#94a3b8',
    marginRight: 6,
  },
  heartIconLiked: {
    color: '#ef4444',
  },
  likeCount: {
    fontSize: 16,
    fontWeight: '600',
    color: '#f1f5f9',
  },
  likeCountLiked: {
    color: '#ef4444',
  },
  viewCount: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 4,
  },
});
