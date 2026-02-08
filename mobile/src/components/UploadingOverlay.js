import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';

export default function UploadingOverlay({ progress }) {
  const pct = Math.round((progress || 0) * 100);

  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        <ActivityIndicator size="large" color="#7c5bf0" />
        <Text style={styles.text}>Uploading video...</Text>
        {progress > 0 && progress < 1 && (
          <Text style={styles.pct}>{pct}%</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 200,
  },
  card: {
    backgroundColor: '#1a1a2e',
    borderRadius: 16,
    padding: 32,
    alignItems: 'center',
    minWidth: 200,
  },
  text: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 16,
  },
  pct: {
    color: '#aaa',
    fontSize: 14,
    marginTop: 8,
  },
});
