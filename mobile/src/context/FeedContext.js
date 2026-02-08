import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { getFeed, trackView, likeSplat } from '../services/api';

const FeedContext = createContext(null);

const PAGE_SIZE = 10;
const VIEW_DWELL_MS = 2000;

export function FeedProvider({ children }) {
  const [items, setItems] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [likedIds, setLikedIds] = useState(new Set());
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

  const toggleLike = useCallback((jobId) => {
    if (likedIds.has(jobId)) return;
    setLikedIds((prev) => new Set(prev).add(jobId));
    // Optimistically increment the like count in local state
    setItems((prev) =>
      prev.map((item) =>
        item.job_id === jobId ? { ...item, like_count: (item.like_count || 0) + 1 } : item
      )
    );
    likeSplat(jobId);
  }, [likedIds]);

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
        goNext,
        goPrevious,
        startDwellTimer,
        toggleLike,
        likedIds,
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
