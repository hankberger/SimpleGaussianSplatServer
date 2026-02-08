import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useJob } from '../context/JobContext';
import { checkHealth } from '../services/api';
import CameraRecorder from '../components/CameraRecorder';
import UploadingOverlay from '../components/UploadingOverlay';

export default function CaptureScreen() {
  const { startUpload, isUploading, uploadError, uploadProgress } = useJob();
  const [showCamera, setShowCamera] = useState(false);
  const [serverOnline, setServerOnline] = useState(null); // null = unknown, true/false
  const intervalRef = useRef(null);

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

  // Show error
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

  return (
    <View style={styles.container}>
      {isUploading && <UploadingOverlay progress={uploadProgress} />}

      {serverOnline !== null && (
        <View style={styles.statusContainer}>
          <View style={[styles.statusDot, { backgroundColor: serverOnline ? '#2ecc71' : '#e74c3c' }]} />
          <Text style={styles.statusText}>{serverOnline ? 'Server online' : 'Server offline'}</Text>
        </View>
      )}

      <View style={styles.content}>
        <Text style={styles.title}>Create a 3D Splat</Text>
        <Text style={styles.subtitle}>
          Record a video walking around an object, or pick one from your gallery.
        </Text>

        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => setShowCamera(true)}
          disabled={isUploading}
        >
          <Ionicons name="videocam" size={24} color="#fff" />
          <Text style={styles.primaryBtnText}>Record Video</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.secondaryBtn}
          onPress={handlePickVideo}
          disabled={isUploading}
        >
          <Ionicons name="images-outline" size={24} color="#7c5bf0" />
          <Text style={styles.secondaryBtnText}>Choose from Gallery</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  statusContainer: {
    position: 'absolute',
    top: 56,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 10,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 6,
  },
  statusText: {
    color: '#888',
    fontSize: 12,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  title: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8,
  },
  subtitle: {
    color: '#aaa',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 48,
    maxWidth: 280,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#7c5bf0',
    paddingHorizontal: 28,
    paddingVertical: 16,
    borderRadius: 12,
    marginBottom: 16,
    width: '100%',
    justifyContent: 'center',
    gap: 10,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: '#7c5bf0',
    paddingHorizontal: 28,
    paddingVertical: 16,
    borderRadius: 12,
    width: '100%',
    justifyContent: 'center',
    gap: 10,
  },
  secondaryBtnText: {
    color: '#7c5bf0',
    fontSize: 17,
    fontWeight: '600',
  },
});
