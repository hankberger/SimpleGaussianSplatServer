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
      </View>

      {items.length > 0 && (
        <View style={styles.navBar}>
          <TouchableOpacity
            style={[styles.navButton, !hasPrevious && styles.navButtonDisabled]}
            onPress={goPrevious}
            disabled={!hasPrevious}
          >
            <Text style={[styles.navButtonText, !hasPrevious && styles.navButtonTextDisabled]}>
              Prev
            </Text>
          </TouchableOpacity>

          <View style={styles.navInfo}>
            <Text style={styles.navCounter} numberOfLines={1}>
              {currentIndex + 1} / {total}
            </Text>
            {currentItem && (
              <Text style={styles.navViews} numberOfLines={1}>
                {currentItem.view_count} {currentItem.view_count === 1 ? 'view' : 'views'}
              </Text>
            )}
          </View>

          <TouchableOpacity
            style={[styles.navButton, !hasNext && styles.navButtonDisabled]}
            onPress={goNext}
            disabled={!hasNext}
          >
            <Text style={[styles.navButtonText, !hasNext && styles.navButtonTextDisabled]}>
              Next
            </Text>
          </TouchableOpacity>
        </View>
      )}
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
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(11, 15, 26, 0.95)',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  navButton: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  navButtonDisabled: {
    opacity: 0.3,
  },
  navButtonText: {
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: '600',
  },
  navButtonTextDisabled: {
    color: '#475569',
  },
  navInfo: {
    flex: 1,
    alignItems: 'center',
  },
  navCounter: {
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: '600',
  },
  navViews: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 2,
  },
});
