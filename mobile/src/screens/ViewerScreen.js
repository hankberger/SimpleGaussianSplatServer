import React, { useRef, useMemo, useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Animated } from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { RENDERER_URL } from '../config';
import { useJob } from '../context/JobContext';
import { useFeed } from '../context/FeedContext';
import { useAuth } from '../context/AuthContext';
import ProgressBar from '../components/ProgressBar';

/* ------------------------------------------------------------------ *
 *  Injected into the WebView to detect vertical swipes & double-taps *
 *  Fast vertical fling (< 300 ms, > 80 px, mostly vertical)         *
 *    → posts { type:'swipe', direction:'up'|'down' }                 *
 *  Double tap (< 300 ms gap, < 10 px movement)                      *
 *    → posts { type:'doubleTap' }                                    *
 * ------------------------------------------------------------------ */
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
    if(dt<300&&Math.abs(dy)>80&&Math.abs(dy)>Math.abs(dx)*2){
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'swipe',direction:dy<0?'up':'down'}));
      return;
    }
    var now=Date.now();
    if(now-lt<300&&dt<200&&Math.abs(dy)<10&&Math.abs(dx)<10){
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'doubleTap'}));
      lt=0;
    }else{lt=now;}
  },{passive:true});
})();true;
`;

export default function ViewerScreen() {
  const webViewRef = useRef(null);
  const navigation = useNavigation();
  const { activeJobId, jobStatus } = useJob();
  const { isAuthenticated } = useAuth();
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
  } = useFeed();

  /* ---- animations ---- */
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(0)).current;
  const [heartVisible, setHeartVisible] = useState(false);
  const heartScale = useRef(new Animated.Value(0)).current;
  const heartOpacity = useRef(new Animated.Value(0)).current;
  const prevIndex = useRef(currentIndex);

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

  // Slide + fade transition when switching items
  useEffect(() => {
    if (prevIndex.current !== currentIndex) {
      const dir = currentIndex > prevIndex.current ? 1 : -1;
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: true }),
        Animated.timing(slideAnim, { toValue: -dir * 40, duration: 120, useNativeDriver: true }),
      ]).start(() => {
        slideAnim.setValue(dir * 24);
        Animated.parallel([
          Animated.timing(fadeAnim, { toValue: 1, duration: 180, useNativeDriver: true }),
          Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, tension: 80, friction: 12 }),
        ]).start();
      });
      prevIndex.current = currentIndex;
    }
  }, [currentIndex, fadeAnim, slideAnim]);

  /* ---- derived URL ---- */
  const webViewUrl = useMemo(() => {
    if (activeJobId && jobStatus?.status === 'completed') {
      return `${RENDERER_URL}?url=/jobs/${activeJobId}/output.splat&feed=1`;
    }
    if (currentItem) {
      return `${RENDERER_URL}?url=${encodeURIComponent(currentItem.splat_url)}&feed=1`;
    }
    return null;
  }, [activeJobId, jobStatus?.status, currentItem]);

  /* ---- actions ---- */
  const handleLike = useCallback(async () => {
    if (!currentItem) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const result = await toggleLike(currentItem.job_id, isAuthenticated);
    if (result?.needsAuth) {
      navigation.navigate('Profile');
    }
  }, [currentItem, toggleLike, isAuthenticated, navigation]);

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

  const handleWebViewMessage = useCallback(
    (event) => {
      try {
        const data = JSON.parse(event.nativeEvent.data);
        if (data.type === 'swipe') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          if (data.direction === 'up') goNext();
          else goPrevious();
        } else if (data.type === 'doubleTap') {
          if (currentItem && !currentItem.liked_by_me) {
            handleLike();
          }
          showHeartAnimation();
        }
      } catch {
        /* ignore non-JSON messages */
      }
    },
    [goNext, goPrevious, currentItem, handleLike, showHeartAnimation]
  );

  /* ---- derived state ---- */
  const isLiked = currentItem?.liked_by_me ?? false;
  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex < items.length - 1;

  /* ============ RENDER ============ */

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
      {/* 3D Splat Viewer */}
      <Animated.View
        style={[
          styles.webviewContainer,
          { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
        ]}
      >
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
          injectedJavaScript={INJECTED_JS}
          onMessage={handleWebViewMessage}
        />
      </Animated.View>

      {/* Overlay UI — pointerEvents="box-none" passes touches through */}
      <View style={styles.overlay} pointerEvents="box-none">
        <ProgressBar />

        {/* Position counter (top right) */}
        {items.length > 1 && (
          <View style={styles.positionBadge}>
            <Text style={styles.positionText}>
              {currentIndex + 1} / {total || items.length}
            </Text>
          </View>
        )}

        {/* Right sidebar — Instagram Reels style */}
        {items.length > 0 && (
          <View style={styles.sidebar} pointerEvents="box-none">
            {/* Like */}
            <TouchableOpacity
              style={styles.sidebarItem}
              onPress={handleLike}
              activeOpacity={0.7}
            >
              <Ionicons
                name={isLiked ? 'heart' : 'heart-outline'}
                size={30}
                color={isLiked ? '#ef4444' : '#f1f5f9'}
                style={styles.iconShadow}
              />
              <Text style={[styles.sidebarCount, isLiked && styles.countLiked]}>
                {currentItem?.like_count || 0}
              </Text>
            </TouchableOpacity>

            {/* Views */}
            <View style={styles.sidebarItem}>
              <Ionicons
                name="eye-outline"
                size={28}
                color="#f1f5f9"
                style={styles.iconShadow}
              />
              <Text style={styles.sidebarCount}>
                {currentItem?.view_count || 0}
              </Text>
            </View>

            {/* Navigation chevrons */}
            <View style={styles.navGroup}>
              <TouchableOpacity
                style={[styles.navChevron, !hasPrevious && styles.navChevronDisabled]}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  goPrevious();
                }}
                disabled={!hasPrevious}
                activeOpacity={0.7}
              >
                <Ionicons
                  name="chevron-up"
                  size={22}
                  color={hasPrevious ? '#f1f5f9' : '#475569'}
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.navChevron, !hasNext && styles.navChevronDisabled]}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  goNext();
                }}
                disabled={!hasNext}
                activeOpacity={0.7}
              >
                <Ionicons
                  name="chevron-down"
                  size={22}
                  color={hasNext ? '#f1f5f9' : '#475569'}
                />
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Swipe hint — shows briefly on first item */}
        {items.length > 1 && currentIndex === 0 && (
          <View style={styles.swipeHint} pointerEvents="none">
            <Ionicons name="chevron-up" size={18} color="#94a3b8" />
            <Text style={styles.swipeHintText}>Swipe up for more</Text>
          </View>
        )}
      </View>

      {/* Double-tap heart animation */}
      {heartVisible && (
        <View style={styles.heartOverlay} pointerEvents="none">
          <Animated.View
            style={{
              opacity: heartOpacity,
              transform: [{ scale: heartScale }],
            }}
          >
            <Ionicons name="heart" size={90} color="#ef4444" style={styles.heartDrop} />
          </Animated.View>
        </View>
      )}
    </View>
  );
}

/* ================================================================== */
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  webviewContainer: {
    flex: 1,
  },
  webview: {
    flex: 1,
    backgroundColor: '#000',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },

  /* -- empty / loading / error states -- */
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

  /* -- position badge (top-right) -- */
  positionBadge: {
    position: 'absolute',
    top: 58,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  positionText: {
    color: '#f1f5f9',
    fontSize: 12,
    fontWeight: '600',
  },

  /* -- right sidebar (Instagram Reels style) -- */
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

  /* -- nav chevrons -- */
  navGroup: {
    alignItems: 'center',
    gap: 2,
  },
  navChevron: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  navChevronDisabled: {
    opacity: 0.3,
  },

  /* -- swipe hint -- */
  swipeHint: {
    position: 'absolute',
    bottom: 20,
    alignSelf: 'center',
    alignItems: 'center',
    opacity: 0.6,
  },
  swipeHintText: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 2,
  },

  /* -- double-tap heart overlay -- */
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
