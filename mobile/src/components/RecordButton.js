import React, { useEffect, useRef } from 'react';
import { View, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

const BUTTON_SIZE = 72;
const RING_SIZE = 88;
const STROKE_WIDTH = 3.5;
const RADIUS = (RING_SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export default function RecordButton({ isRecording, onPress, progress }) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const animatedProgress = useRef(new Animated.Value(0)).current;

  // Pulsing animation while recording
  useEffect(() => {
    if (isRecording) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 0.85,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isRecording]);

  // Animate progress smoothly
  useEffect(() => {
    Animated.timing(animatedProgress, {
      toValue: progress || 0,
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [progress]);

  const strokeDashoffset = animatedProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [CIRCUMFERENCE, 0],
  });

  return (
    <View style={styles.wrapper}>
      {/* SVG progress ring */}
      <Svg
        width={RING_SIZE}
        height={RING_SIZE}
        style={styles.ringSvg}
      >
        {/* Background track */}
        <Circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RADIUS}
          stroke="rgba(255, 255, 255, 0.2)"
          strokeWidth={STROKE_WIDTH}
          fill="none"
        />
        {/* Animated progress arc */}
        <AnimatedCircle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RADIUS}
          stroke="#e74c3c"
          strokeWidth={STROKE_WIDTH}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={strokeDashoffset}
          rotation="-90"
          origin={`${RING_SIZE / 2}, ${RING_SIZE / 2}`}
        />
      </Svg>
      <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
        <Animated.View
          style={[
            styles.button,
            isRecording && styles.buttonRecording,
            { transform: [{ scale: pulseAnim }] },
          ]}
        >
          {isRecording && <View style={styles.stopSquare} />}
        </Animated.View>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: RING_SIZE,
    height: RING_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringSvg: {
    position: 'absolute',
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    backgroundColor: '#e74c3c',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonRecording: {
    backgroundColor: '#c0392b',
  },
  stopSquare: {
    width: 24,
    height: 24,
    borderRadius: 4,
    backgroundColor: '#fff',
  },
});
