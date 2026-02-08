import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { useJob } from '../context/JobContext';

const STAGE_WEIGHTS = {
  frame_extraction: 0.05,
  pose_estimation: 0.30,
  training: 0.60,
  conversion: 0.05,
};

const STAGE_LABELS = {
  frame_extraction: 'Extracting frames',
  pose_estimation: 'Estimating poses',
  training: 'Training gaussians',
  conversion: 'Converting output',
};

function computeProgress(stages) {
  if (!stages || stages.length === 0) return 0;

  let progress = 0;
  for (const stage of stages) {
    const weight = STAGE_WEIGHTS[stage.name] || 0;
    if (stage.status === 'completed') {
      progress += weight;
    } else if (stage.status === 'running') {
      // For training, parse "step X/Y" for sub-progress
      if (stage.name === 'training' && stage.detail) {
        const match = stage.detail.match(/step (\d+)\/(\d+)/);
        if (match) {
          const step = parseInt(match[1], 10);
          const total = parseInt(match[2], 10);
          progress += weight * (step / total);
          continue;
        }
      }
      progress += weight * 0.1; // 10% progress for "running" without detail
    }
  }
  return Math.min(progress, 1);
}

function getCurrentStage(stages) {
  if (!stages) return null;
  return stages.find((s) => s.status === 'running') || null;
}

export default function ProgressBar() {
  const { activeJobId, jobStatus } = useJob();
  const animatedWidth = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const fadeTimeout = useRef(null);

  const progress = jobStatus ? computeProgress(jobStatus.stages) : 0;
  const currentStage = jobStatus ? getCurrentStage(jobStatus.stages) : null;
  const isCompleted = jobStatus?.status === 'completed';
  const isFailed = jobStatus?.status === 'failed';

  useEffect(() => {
    Animated.timing(animatedWidth, {
      toValue: progress,
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [progress]);

  // Fade out after completion
  useEffect(() => {
    if (isCompleted) {
      fadeTimeout.current = setTimeout(() => {
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 500,
          useNativeDriver: true,
        }).start();
      }, 3000);
    } else {
      fadeAnim.setValue(1);
      if (fadeTimeout.current) clearTimeout(fadeTimeout.current);
    }
    return () => {
      if (fadeTimeout.current) clearTimeout(fadeTimeout.current);
    };
  }, [isCompleted]);

  if (!activeJobId || (!currentStage && !isCompleted && !isFailed)) return null;

  const barColor = isFailed ? '#e74c3c' : isCompleted ? '#2ecc71' : '#7c5bf0';
  const stageLabel = isCompleted
    ? 'Complete!'
    : isFailed
    ? `Failed: ${jobStatus.error || 'Unknown error'}`
    : STAGE_LABELS[currentStage?.name] || currentStage?.name;

  const detailText = currentStage?.detail || '';

  return (
    <Animated.View
      style={[styles.container, { opacity: fadeAnim }]}
      pointerEvents="box-none"
    >
      <View style={styles.pill}>
        <Text style={styles.stageText} numberOfLines={1}>
          {stageLabel}
        </Text>
        {!!detailText && !isCompleted && (
          <Text style={styles.detailText} numberOfLines={1}>
            {detailText}
          </Text>
        )}
        <View style={styles.barBg}>
          <Animated.View
            style={[
              styles.barFill,
              {
                backgroundColor: barColor,
                width: animatedWidth.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0%', '100%'],
                }),
              },
            ]}
          />
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 60,
    left: 16,
    right: 16,
    zIndex: 100,
  },
  pill: {
    backgroundColor: 'rgba(20, 20, 40, 0.9)',
    borderRadius: 12,
    padding: 12,
    paddingBottom: 10,
  },
  stageText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  detailText: {
    color: '#aaa',
    fontSize: 12,
    marginBottom: 4,
  },
  barBg: {
    height: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 3,
    marginTop: 4,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 3,
  },
});
