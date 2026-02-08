import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useJob } from '../context/JobContext';
import { checkHealth } from '../services/api';
import { MAX_RECORD_SECONDS } from '../config';
import RecordButton from '../components/RecordButton';
import UploadingOverlay from '../components/UploadingOverlay';

export default function CaptureScreen() {
  const { startUpload, isUploading, uploadError, uploadProgress } = useJob();
  const cameraRef = useRef(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [serverOnline, setServerOnline] = useState(null);
  const [facing, setFacing] = useState('back');
  const timerRef = useRef(null);
  const intervalRef = useRef(null);

  // Recording timer
  useEffect(() => {
    if (isRecording) {
      setElapsed(0);
      timerRef.current = setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRecording]);

  // Server health polling
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

  useEffect(() => {
    if (uploadError) Alert.alert('Upload Failed', uploadError);
  }, [uploadError]);

  const startRecording = useCallback(async () => {
    if (!cameraRef.current || isRecording) return;
    setIsRecording(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const video = await cameraRef.current.recordAsync({
        maxDuration: MAX_RECORD_SECONDS,
      });
      if (video?.uri) {
        startUpload(video.uri);
      }
    } catch (err) {
      console.warn('Recording error:', err);
    } finally {
      setIsRecording(false);
    }
  }, [isRecording, startUpload]);

  const stopRecording = useCallback(() => {
    if (cameraRef.current && isRecording) {
      cameraRef.current.stopRecording();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, [isRecording]);

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

  const formatTime = (secs) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // Permission not yet determined
  if (!permission) return <View style={styles.container} />;

  // Permission denied — show prompt
  if (!permission.granted) {
    return (
      <View style={styles.permissionContainer}>
        <Ionicons name="camera-outline" size={64} color="#475569" />
        <Text style={styles.permissionText}>
          Camera access is required to record video
        </Text>
        <TouchableOpacity style={styles.permissionBtn} onPress={requestPermission}>
          <Text style={styles.permissionBtnText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Full-screen camera */}
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        mode="video"
        facing={facing}
      />

      {/* Upload overlay */}
      {isUploading && <UploadingOverlay progress={uploadProgress} />}

      {/* Server status pill */}
      {serverOnline !== null && (
        <View style={styles.statusWrap}>
          <View style={styles.statusPill}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: serverOnline ? '#22c55e' : '#ef4444' },
              ]}
            />
            <Text style={styles.statusText}>
              {serverOnline ? 'Connected' : 'Offline'}
            </Text>
          </View>
        </View>
      )}

      {/* Recording timer */}
      {isRecording && (
        <View style={styles.timerContainer}>
          <View style={styles.timerDot} />
          <Text style={styles.timerText}>{formatTime(elapsed)}</Text>
        </View>
      )}

      {/* Bottom controls */}
      <View style={styles.controls}>
        {/* Gallery button */}
        <TouchableOpacity
          style={styles.galleryBtn}
          onPress={handlePickVideo}
          disabled={isUploading || isRecording}
          activeOpacity={0.7}
        >
          <Ionicons name="images-outline" size={26} color="#fff" />
        </TouchableOpacity>

        {/* Record button */}
        <RecordButton
          isRecording={isRecording}
          onPress={isRecording ? stopRecording : startRecording}
          progress={elapsed / MAX_RECORD_SECONDS}
        />

        {/* Flip camera button */}
        <TouchableOpacity
          style={styles.galleryBtn}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setFacing((f) => (f === 'back' ? 'front' : 'back'));
          }}
          disabled={isRecording}
          activeOpacity={0.7}
        >
          <Ionicons name="camera-reverse-outline" size={26} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },

  /* Permission screen */
  permissionContainer: {
    flex: 1,
    backgroundColor: '#0b0f1a',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  permissionText: {
    color: '#94a3b8',
    fontSize: 16,
    textAlign: 'center',
    marginTop: 16,
    marginBottom: 24,
  },
  permissionBtn: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  permissionBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },

  /* Status pill */
  statusWrap: {
    position: 'absolute',
    top: 56,
    right: 20,
    zIndex: 10,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  statusText: {
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
  },

  /* Timer */
  timerContainer: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    zIndex: 10,
  },
  timerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#ef4444',
    marginRight: 8,
  },
  timerText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },

  /* Bottom controls */
  controls: {
    position: 'absolute',
    bottom: 50,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 40,
  },
  galleryBtn: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
