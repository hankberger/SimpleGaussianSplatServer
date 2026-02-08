import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { getFeed, trackView, likeSplat, unlikeSplat } from '../services/api';

const FeedContext = createContext(null);

const PAGE_SIZE = 10;
const VIEW_DWELL_MS = 2000;

export function FeedProvider({ children }) {
  const [items, setItems] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const dwellTimer = useRef(null);
  const trackedIds = useRef(new Set());

  const loadFeed = useCallback(async (reset = true) => {
    setLoading(true);
    setError(null);
    try {
      const offset = reset ? 0 : items.length;
      const data = await getFeed(PAGE_SIZE, offset);
      if (reset) {
        setItems(data.items);
        setCurrentIndex(0);
      } else {
        setItems((prev) => [...prev, ...data.items]);
      }
      setTotal(data.total);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [items.length]);

  const startDwellTimer = useCallback((jobId) => {
    if (dwellTimer.current) clearTimeout(dwellTimer.current);
    if (trackedIds.current.has(jobId)) return;
    dwellTimer.current = setTimeout(() => {
      trackedIds.current.add(jobId);
      trackView(jobId);
    }, VIEW_DWELL_MS);
  }, []);

  const selectItem = useCallback((index) => {
    if (dwellTimer.current) clearTimeout(dwellTimer.current);
    setCurrentIndex(index);
  }, []);

  const loadMore = useCallback(() => {
    if (loading || items.length >= total) return;
    loadFeed(false);
  }, [loading, items.length, total, loadFeed]);

  const goNext = useCallback(() => {
    if (dwellTimer.current) clearTimeout(dwellTimer.current);
    setCurrentIndex((prev) => {
      const next = prev + 1;
      if (next >= items.length) return prev;
      // Auto-paginate: load more when near end
      if (next >= items.length - 2 && items.length < total) {
        loadFeed(false);
      }
      return next;
    });
  }, [items.length, total, loadFeed]);

  const goPrevious = useCallback(() => {
    if (dwellTimer.current) clearTimeout(dwellTimer.current);
    setCurrentIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const toggleLike = useCallback(async (jobId, isAuthenticated) => {
    if (!isAuthenticated) {
      return { needsAuth: true };
    }

    const item = items.find((i) => i.job_id === jobId);
    if (!item) return {};

    const wasLiked = item.liked_by_me;

    // Optimistic update
    setItems((prev) =>
      prev.map((i) =>
        i.job_id === jobId
          ? {
              ...i,
              liked_by_me: !wasLiked,
              like_count: wasLiked
                ? Math.max(0, (i.like_count || 0) - 1)
                : (i.like_count || 0) + 1,
            }
          : i
      )
    );

    try {
      if (wasLiked) {
        await unlikeSplat(jobId);
      } else {
        await likeSplat(jobId);
      }
    } catch {
      // Rollback on failure
      setItems((prev) =>
        prev.map((i) =>
          i.job_id === jobId
            ? {
                ...i,
                liked_by_me: wasLiked,
                like_count: wasLiked
                  ? (i.like_count || 0) + 1
                  : Math.max(0, (i.like_count || 0) - 1),
              }
            : i
        )
      );
    }

    return {};
  }, [items]);

  const currentItem = items[currentIndex] || null;

  return (
    <FeedContext.Provider
      value={{
        items,
        currentIndex,
        currentItem,
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
      }}
    >
      {children}
    </FeedContext.Provider>
  );
}

export function useFeed() {
  const ctx = useContext(FeedContext);
  if (!ctx) throw new Error('useFeed must be used within a FeedProvider');
  return ctx;
}
