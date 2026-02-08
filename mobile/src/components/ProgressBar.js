import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useJob } from '../context/JobContext';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

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

const RING_SIZE = 40;
const STROKE_WIDTH = 4;
const RADIUS = (RING_SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function computeProgress(stages) {
  if (!stages || stages.length === 0) return 0;

  let progress = 0;
  for (const stage of stages) {
    const weight = STAGE_WEIGHTS[stage.name] || 0;
    if (stage.status === 'completed') {
      progress += weight;
    } else if (stage.status === 'running') {
      if (stage.name === 'training' && stage.detail) {
        const match = stage.detail.match(/step (\d+)\/(\d+)/);
        if (match) {
          const step = parseInt(match[1], 10);
          const total = parseInt(match[2], 10);
          progress += weight * (step / total);
          continue;
        }
      }
      progress += weight * 0.1;
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
  const animatedProgress = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const fadeTimeout = useRef(null);

  const progress = jobStatus ? computeProgress(jobStatus.stages) : 0;
  const currentStage = jobStatus ? getCurrentStage(jobStatus.stages) : null;
  const isCompleted = jobStatus?.status === 'completed';
  const isFailed = jobStatus?.status === 'failed';

  useEffect(() => {
    Animated.timing(animatedProgress, {
      toValue: progress,
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [progress]);

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

  const barColor = isFailed ? '#ef4444' : isCompleted ? '#22c55e' : '#3b82f6';
  const stageLabel = isCompleted
    ? 'Complete!'
    : isFailed
    ? `Failed: ${jobStatus.error || 'Unknown error'}`
    : STAGE_LABELS[currentStage?.name] || currentStage?.name;

  const detailText = currentStage?.detail || '';

  const animatedDashOffset = animatedProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [CIRCUMFERENCE, 0],
  });

  const percentText = Math.round(progress * 100) + '%';

  return (
    <Animated.View
      style={[styles.container, { opacity: fadeAnim }]}
      pointerEvents="box-none"
    >
      <View style={styles.pill}>
        <View style={styles.ringContainer}>
          <Svg width={RING_SIZE} height={RING_SIZE}>
            <Circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RADIUS}
              stroke="rgba(255, 255, 255, 0.1)"
              strokeWidth={STROKE_WIDTH}
              fill="none"
            />
            <AnimatedCircle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RADIUS}
              stroke={barColor}
              strokeWidth={STROKE_WIDTH}
              fill="none"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={animatedDashOffset}
              strokeLinecap="round"
              transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
            />
          </Svg>
          <View style={styles.percentOverlay}>
            <Text style={styles.percentText}>{percentText}</Text>
          </View>
        </View>
        <View style={styles.textContainer}>
          <Text style={styles.stageText} numberOfLines={1}>
            {stageLabel}
          </Text>
          {!!detailText && !isCompleted && (
            <Text style={styles.detailText} numberOfLines={1}>
              {detailText}
            </Text>
          )}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 16,
    marginBottom: 12,
  },
  pill: {
    backgroundColor: 'rgba(11, 15, 26, 0.9)',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  ringContainer: {
    width: RING_SIZE,
    height: RING_SIZE,
    marginRight: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  percentOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  percentText: {
    color: '#f1f5f9',
    fontSize: 10,
    fontWeight: '700',
  },
  textContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  stageText: {
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: '600',
  },
  detailText: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 2,
  },
});
