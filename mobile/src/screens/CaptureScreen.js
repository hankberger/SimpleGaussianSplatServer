import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Animated,
  Dimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useJob } from '../context/JobContext';
import { checkHealth } from '../services/api';
import CameraRecorder from '../components/CameraRecorder';
import UploadingOverlay from '../components/UploadingOverlay';

const { width } = Dimensions.get('window');

function FloatingOrb({ delay, duration, startX, startY, size, color }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(anim, {
          toValue: 1,
          duration,
          useNativeDriver: true,
        }),
        Animated.timing(anim, {
          toValue: 0,
          duration,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  const translateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -30],
  });

  const opacity = anim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.15, 0.4, 0.15],
  });

  return (
    <Animated.View
      style={[
        styles.orb,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          left: startX,
          top: startY,
          transform: [{ translateY }],
          opacity,
        },
      ]}
    />
  );
}

function PipelineStep({ icon, label, isLast }) {
  return (
    <View style={styles.pipelineStep}>
      <View style={styles.pipelineIcon}>
        <Ionicons name={icon} size={16} color="#60a5fa" />
      </View>
      <Text style={styles.pipelineLabel}>{label}</Text>
      {!isLast && (
        <Ionicons
          name="chevron-forward"
          size={14}
          color="#334155"
          style={styles.pipelineArrow}
        />
      )}
    </View>
  );
}

export default function CaptureScreen() {
  const { startUpload, isUploading, uploadError, uploadProgress } = useJob();
  const [showCamera, setShowCamera] = useState(false);
  const [serverOnline, setServerOnline] = useState(null);
  const intervalRef = useRef(null);
  const heroAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(heroAnim, {
      toValue: 1,
      duration: 800,
      useNativeDriver: true,
    }).start();
  }, []);

  useEffect(() => {
    const poll = () => {
      checkHealth()
        .then(() => setServerOnline(true))
        .catch(() => setServerOnline(false));
    };
    poll();
    intervalRef.current = setInterval(poll, 5000);
    return () => clearInterval(intervalRef.current);
  }, []);

  const handleVideoRecorded = useCallback((uri) => {
    setShowCamera(false);
    startUpload(uri);
  }, [startUpload]);

  const handlePickVideo = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'videos',
        quality: 1,
      });

      if (!result.canceled && result.assets?.[0]?.uri) {
        startUpload(result.assets[0].uri);
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to pick video from gallery');
    }
  }, [startUpload]);

  React.useEffect(() => {
    if (uploadError) {
      Alert.alert('Upload Failed', uploadError);
    }
  }, [uploadError]);

  if (showCamera) {
    return (
      <CameraRecorder
        onVideoRecorded={handleVideoRecorded}
        onCancel={() => setShowCamera(false)}
      />
    );
  }

  const heroTranslateY = heroAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [30, 0],
  });

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={['#0b0f1a', '#0f172a', '#0b0f1a']}
        style={StyleSheet.absoluteFill}
      />

      {/* Floating orbs */}
      <FloatingOrb delay={0} duration={3000} startX={width * 0.1} startY={120} size={120} color="#1e3a5f" />
      <FloatingOrb delay={500} duration={4000} startX={width * 0.6} startY={200} size={80} color="#1e3a5f" />
      <FloatingOrb delay={1000} duration={3500} startX={width * 0.3} startY={500} size={100} color="#172554" />

      {isUploading && <UploadingOverlay progress={uploadProgress} />}

      {/* Status indicator */}
      {serverOnline !== null && (
        <View style={styles.statusContainer}>
          <View style={styles.statusPill}>
            <View style={[styles.statusDot, { backgroundColor: serverOnline ? '#22c55e' : '#ef4444' }]} />
            <Text style={styles.statusText}>{serverOnline ? 'Online' : 'Offline'}</Text>
          </View>
        </View>
      )}

      <Animated.View
        style={[
          styles.content,
          { opacity: heroAnim, transform: [{ translateY: heroTranslateY }] },
        ]}
      >
        {/* Hero icon */}
        <View style={styles.heroIconContainer}>
          <LinearGradient
            colors={['#1d4ed8', '#3b82f6']}
            style={styles.heroIconGradient}
          >
            <Ionicons name="cube" size={40} color="#fff" />
          </LinearGradient>
          <View style={styles.heroGlow} />
        </View>

        <Text style={styles.title}>Create a 3D Splat</Text>
        <Text style={styles.subtitle}>
          Capture video of any object and transform it into an interactive 3D model.
        </Text>

        {/* Pipeline steps */}
        <View style={styles.pipeline}>
          <PipelineStep icon="videocam-outline" label="Record" />
          <PipelineStep icon="sync-outline" label="Process" />
          <PipelineStep icon="cube-outline" label="View 3D" isLast />
        </View>

        {/* Action cards */}
        <TouchableOpacity
          style={styles.card}
          onPress={() => setShowCamera(true)}
          disabled={isUploading}
          activeOpacity={0.8}
        >
          <LinearGradient
            colors={['#1d4ed8', '#2563eb']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.cardGradient}
          >
            <View style={styles.cardIconWrap}>
              <Ionicons name="videocam" size={28} color="#fff" />
            </View>
            <View style={styles.cardTextWrap}>
              <Text style={styles.cardTitle}>Record Video</Text>
              <Text style={styles.cardDesc}>Use your camera to capture an object</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.5)" />
          </LinearGradient>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.card}
          onPress={handlePickVideo}
          disabled={isUploading}
          activeOpacity={0.8}
        >
          <View style={styles.cardOutline}>
            <View style={styles.cardIconWrap}>
              <Ionicons name="images-outline" size={28} color="#60a5fa" />
            </View>
            <View style={styles.cardTextWrap}>
              <Text style={styles.cardTitleOutline}>Choose from Gallery</Text>
              <Text style={styles.cardDesc}>Select an existing video</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#334155" />
          </View>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0f1a',
  },
  orb: {
    position: 'absolute',
  },
  statusContainer: {
    position: 'absolute',
    top: 56,
    right: 20,
    zIndex: 10,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.8)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '500',
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  heroIconContainer: {
    marginBottom: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroIconGradient: {
    width: 80,
    height: 80,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroGlow: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#3b82f6',
    opacity: 0.12,
  },
  title: {
    color: '#f1f5f9',
    fontSize: 30,
    fontWeight: '800',
    marginBottom: 10,
    letterSpacing: -0.5,
  },
  subtitle: {
    color: '#64748b',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 28,
    maxWidth: 300,
  },
  pipeline: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 36,
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  pipelineStep: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  pipelineIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  pipelineLabel: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
  },
  pipelineArrow: {
    marginHorizontal: 8,
  },
  card: {
    width: '100%',
    marginBottom: 12,
    borderRadius: 16,
    overflow: 'hidden',
  },
  cardGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 18,
  },
  cardOutline: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 18,
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 16,
  },
  cardIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  cardTextWrap: {
    flex: 1,
  },
  cardTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 2,
  },
  cardTitleOutline: {
    color: '#e2e8f0',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 2,
  },
  cardDesc: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 13,
  },
});
