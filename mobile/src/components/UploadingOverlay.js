import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';

export default function UploadingOverlay({ progress }) {
  const pct = Math.round((progress || 0) * 100);

  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        <ActivityIndicator size="large" color="#3b82f6" />
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
    backgroundColor: '#111827',
    borderRadius: 16,
    padding: 32,
    alignItems: 'center',
    minWidth: 200,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  text: {
    color: '#f1f5f9',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 16,
  },
  pct: {
    color: '#64748b',
    fontSize: 14,
    marginTop: 8,
  },
});
