import React, { useRef, useMemo, useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Animated,
  FlatList,
  Dimensions,
  Platform,
  BackHandler,
  RefreshControl,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { RENDERER_URL } from '../config';
import { useJob } from '../context/JobContext';
import { useFeed } from '../context/FeedContext';
import { useAuth } from '../context/AuthContext';
import AuthModal from '../components/AuthModal';
import ProgressBar from '../components/ProgressBar';

const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = Dimensions.get('window');
const CARD_HEIGHT = 300;

/* ------------------------------------------------------------------ *
 *  Injected into the WebView to detect vertical swipes & double-taps *
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

/* ------------------------------------------------------------------ *
 *  Relative time helper                                              *
 * ------------------------------------------------------------------ */
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

/* ================================================================== *
 *  Main Component                                                     *
 * ================================================================== */
export default function ViewerScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
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
    loadMore,
    selectItem,
    goNext,
    goPrevious,
    startDwellTimer,
    toggleLike,
  } = useFeed();

  /* ---- mode state ---- */
  const [mode, setMode] = useState('feed'); // 'feed' | 'detail'
  const [visibleIndex, setVisibleIndex] = useState(0);
  const [authModalVisible, setAuthModalVisible] = useState(false);

  /* ---- detail animations ---- */
  const detailTranslateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(0)).current;
  const [heartVisible, setHeartVisible] = useState(false);
  const heartScale = useRef(new Animated.Value(0)).current;
  const heartOpacity = useRef(new Animated.Value(0)).current;
  const prevIndex = useRef(currentIndex);
  const detailWebViewRef = useRef(null);

  /* ---- viewability config (stable refs) ---- */
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems.length > 0) {
      setVisibleIndex(viewableItems[0].index);
    }
  }).current;

  /* ---- refresh feed when tab gains focus ---- */
  useFocusEffect(
    useCallback(() => {
      loadFeed(true);
    }, [loadFeed])
  );

  /* ---- open detail mode ---- */
  const openDetail = useCallback(
    (index) => {
      selectItem(index);
      setMode('detail');
      detailTranslateY.setValue(SCREEN_HEIGHT);
      Animated.spring(detailTranslateY, {
        toValue: 0,
        useNativeDriver: true,
        tension: 65,
        friction: 11,
      }).start();
    },
    [selectItem, detailTranslateY]
  );

  /* ---- close detail mode ---- */
  const closeDetail = useCallback(() => {
    Animated.timing(detailTranslateY, {
      toValue: SCREEN_HEIGHT,
      duration: 250,
      useNativeDriver: true,
    }).start(() => {
      setMode('feed');
    });
  }, [detailTranslateY]);

  /* ---- Android back button ---- */
  useEffect(() => {
    if (mode !== 'detail') return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      closeDetail();
      return true;
    });
    return () => handler.remove();
  }, [mode, closeDetail]);

  /* ---- dwell timer for detail mode ---- */
  useEffect(() => {
    if (mode === 'detail' && currentItem) {
      startDwellTimer(currentItem.post_id);
    }
  }, [mode, currentItem, startDwellTimer]);

  /* ---- slide transition in detail mode ---- */
  useEffect(() => {
    if (mode !== 'detail') return;
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
  }, [mode, currentIndex, fadeAnim, slideAnim]);

  /* ---- detail WebView URL ---- */
  const detailWebViewUrl = useMemo(() => {
    if (mode !== 'detail') return null;
    if (activeJobId && jobStatus?.status === 'completed') {
      return `${RENDERER_URL}?url=/jobs/${activeJobId}/output.splat&feed=1`;
    }
    if (currentItem) {
      return `${RENDERER_URL}?url=${encodeURIComponent(currentItem.splat_url)}&feed=1`;
    }
    return null;
  }, [mode, activeJobId, jobStatus?.status, currentItem]);

  /* ---- like handler ---- */
  const handleLike = useCallback(
    async (jobId) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const result = await toggleLike(jobId, isAuthenticated);
      if (result?.needsAuth) {
        setAuthModalVisible(true);
      }
    },
    [toggleLike, isAuthenticated]
  );

  /* ---- heart animation (detail mode double-tap) ---- */
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

  /* ---- detail WebView message handler ---- */
  const handleWebViewMessage = useCallback(
    (event) => {
      try {
        const data = JSON.parse(event.nativeEvent.data);
        if (data.type === 'swipe') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          if (data.direction === 'up') goNext();
          else if (data.direction === 'down') {
            if (currentIndex === 0) {
              closeDetail();
            } else {
              goPrevious();
            }
          }
        } else if (data.type === 'doubleTap') {
          if (currentItem && !currentItem.liked_by_me) {
            handleLike(currentItem.post_id);
          }
          showHeartAnimation();
        }
      } catch {
        /* ignore non-JSON messages */
      }
    },
    [goNext, goPrevious, currentIndex, currentItem, handleLike, showHeartAnimation, closeDetail]
  );

  /* ---- derived state for detail mode ---- */
  const isLiked = currentItem?.liked_by_me ?? false;
  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex < items.length - 1;

  /* ================================================================ *
   *  FEED CARD RENDERER                                               *
   * ================================================================ */
  const renderCard = useCallback(
    ({ item, index }) => {
      const isVisible = index === visibleIndex;
      const liked = item.liked_by_me;
      const splatUrl = `${RENDERER_URL}?url=${encodeURIComponent(item.splat_url)}&feed=1`;

      return (
        <View style={styles.card}>
          {/* Preview area */}
          <TouchableOpacity
            style={styles.cardPreview}
            activeOpacity={0.9}
            onPress={() => openDetail(index)}
          >
            {isVisible ? (
              <WebView
                source={{ uri: splatUrl }}
                style={styles.cardWebView}
                javaScriptEnabled
                domStorageEnabled
                mixedContentMode="always"
                androidLayerType="hardware"
                allowsInlineMediaPlayback
                mediaPlaybackRequiresUserAction={false}
                originWhitelist={['*']}
                scrollEnabled={false}
              />
            ) : (
              <LinearGradient
                colors={['#1a1f2e', '#0d1117', '#161b22']}
                style={styles.cardPlaceholder}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
              >
                <Ionicons name="cube-outline" size={40} color="#334155" />
              </LinearGradient>
            )}
            {/* Tap overlay hint */}
            {!isVisible && (
              <View style={styles.tapHint}>
                <Ionicons name="play-circle-outline" size={44} color="rgba(241,245,249,0.3)" />
              </View>
            )}
          </TouchableOpacity>

          {/* Footer bar */}
          <View style={styles.cardFooter}>
            <TouchableOpacity
              style={styles.cardAction}
              onPress={() => handleLike(item.post_id)}
              activeOpacity={0.7}
            >
              <Ionicons
                name={liked ? 'heart' : 'heart-outline'}
                size={22}
                color={liked ? '#ef4444' : '#94a3b8'}
              />
              <Text style={[styles.cardActionText, liked && styles.cardActionTextLiked]}>
                {item.like_count || 0}
              </Text>
            </TouchableOpacity>

            <View style={styles.cardAction}>
              <Ionicons name="eye-outline" size={20} color="#94a3b8" />
              <Text style={styles.cardActionText}>{item.view_count || 0}</Text>
            </View>

            <Text style={styles.cardTime}>{timeAgo(item.created_at)}</Text>
          </View>
        </View>
      );
    },
    [visibleIndex, openDetail, handleLike]
  );

  const keyExtractor = useCallback((item) => item.post_id, []);

  /* ================================================================ *
   *  RENDER — Loading / Error / Empty states                          *
   * ================================================================ */
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

  if (items.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>No splats yet</Text>
        <Text style={styles.emptySubtext}>Capture a video to create your first splat</Text>
      </View>
    );
  }

  /* ================================================================ *
   *  RENDER — Feed + Detail                                           *
   * ================================================================ */
  return (
    <View style={styles.container}>
      {/* -------- FEED MODE -------- */}
      <View style={[styles.feedContainer, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.feedHeader}>
          <Text style={styles.feedTitle}>Explore</Text>
        </View>

        <FlatList
          data={items}
          renderItem={renderCard}
          keyExtractor={keyExtractor}
          contentContainerStyle={styles.feedList}
          showsVerticalScrollIndicator={false}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          removeClippedSubviews
          windowSize={5}
          maxToRenderPerBatch={4}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={() => loadFeed(true)}
              tintColor="#3b82f6"
              colors={['#3b82f6']}
            />
          }
          ListFooterComponent={
            loading && items.length > 0 ? (
              <ActivityIndicator style={styles.footerLoader} color="#3b82f6" />
            ) : null
          }
        />
      </View>

      {/* -------- DETAIL MODE (slide-up overlay) -------- */}
      {mode === 'detail' && (
        <Animated.View
          style={[
            styles.detailOverlay,
            { transform: [{ translateY: detailTranslateY }] },
          ]}
        >
          {/* 3D viewer */}
          {detailWebViewUrl && (
            <Animated.View
              style={[
                styles.detailWebViewContainer,
                { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
              ]}
            >
              <WebView
                ref={detailWebViewRef}
                source={{ uri: detailWebViewUrl }}
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
            </Animated.View>
          )}

          {/* Overlay UI */}
          <View style={styles.detailUI} pointerEvents="box-none">
            <ProgressBar />

            {/* Close button (top-left) */}
            <TouchableOpacity
              style={[styles.closeButton, { top: insets.top + 12 }]}
              onPress={closeDetail}
              activeOpacity={0.7}
            >
              <Ionicons name="chevron-down" size={26} color="#f1f5f9" />
            </TouchableOpacity>

            {/* Position badge (top-right) */}
            {items.length > 1 && (
              <View style={[styles.positionBadge, { top: insets.top + 16 }]}>
                <Text style={styles.positionText}>
                  {currentIndex + 1} / {total || items.length}
                </Text>
              </View>
            )}

            {/* Right sidebar */}
            <View style={styles.sidebar} pointerEvents="box-none">
              {/* Like */}
              <TouchableOpacity
                style={styles.sidebarItem}
                onPress={() => handleLike(currentItem?.post_id)}
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
                <Ionicons name="eye-outline" size={28} color="#f1f5f9" style={styles.iconShadow} />
                <Text style={styles.sidebarCount}>{currentItem?.view_count || 0}</Text>
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
                  <Ionicons name="chevron-up" size={22} color={hasPrevious ? '#f1f5f9' : '#475569'} />
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
                  <Ionicons name="chevron-down" size={22} color={hasNext ? '#f1f5f9' : '#475569'} />
                </TouchableOpacity>
              </View>
            </View>
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
        </Animated.View>
      )}

      {/* Auth modal */}
      <AuthModal visible={authModalVisible} onClose={() => setAuthModalVisible(false)} />
    </View>
  );
}

/* ================================================================== */
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0f1a',
  },

  /* -- empty / loading / error states -- */
  centered: {
    flex: 1,
    backgroundColor: '#0b0f1a',
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

  /* ====== FEED MODE ====== */
  feedContainer: {
    flex: 1,
  },
  feedHeader: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  feedTitle: {
    color: '#f1f5f9',
    fontSize: 28,
    fontWeight: '700',
  },
  feedList: {
    paddingHorizontal: 16,
    paddingBottom: 100,
  },
  footerLoader: {
    paddingVertical: 20,
  },

  /* -- Card -- */
  card: {
    backgroundColor: '#151a24',
    borderRadius: 16,
    marginBottom: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  cardPreview: {
    height: CARD_HEIGHT,
    backgroundColor: '#0d1117',
  },
  cardWebView: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  cardPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  tapHint: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  cardAction: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 18,
  },
  cardActionText: {
    color: '#94a3b8',
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 6,
  },
  cardActionTextLiked: {
    color: '#ef4444',
  },
  cardTime: {
    color: '#475569',
    fontSize: 13,
    marginLeft: 'auto',
  },

  /* ====== DETAIL MODE ====== */
  detailOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
    zIndex: 100,
  },
  detailWebViewContainer: {
    flex: 1,
  },
  detailWebView: {
    flex: 1,
    backgroundColor: '#000',
  },
  detailUI: {
    ...StyleSheet.absoluteFillObject,
  },

  /* Close button */
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

  /* Position badge */
  positionBadge: {
    position: 'absolute',
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

  /* Right sidebar */
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

  /* Nav chevrons */
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

  /* Heart overlay */
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
