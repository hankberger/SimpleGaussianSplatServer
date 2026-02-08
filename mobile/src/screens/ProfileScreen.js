import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import AuthScreen from './AuthScreen';

export default function ProfileScreen() {
  const { user, isAuthenticated, logout } = useAuth();

  if (!isAuthenticated) {
    return <AuthScreen />;
  }

  const providerLabel = {
    email: 'Email',
    google: 'Google',
    apple: 'Apple',
  }[user.provider] || user.provider;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.avatar}>
          <Ionicons name="person" size={40} color="#64748b" />
        </View>
        <Text style={styles.displayName}>
          {user.display_name || 'User'}
        </Text>
        <Text style={styles.email}>{user.email}</Text>
        <View style={styles.providerBadge}>
          <Ionicons
            name={user.provider === 'apple' ? 'logo-apple' : user.provider === 'google' ? 'logo-google' : 'mail-outline'}
            size={14}
            color="#94a3b8"
          />
          <Text style={styles.providerText}>Signed in with {providerLabel}</Text>
        </View>
      </View>

      <TouchableOpacity style={styles.signOutButton} onPress={logout}>
        <Ionicons name="log-out-outline" size={20} color="#ef4444" />
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0f1a',
    padding: 24,
    justifyContent: 'space-between',
  },
  header: {
    alignItems: 'center',
    paddingTop: 80,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  displayName: {
    color: '#f1f5f9',
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 4,
  },
  email: {
    color: '#94a3b8',
    fontSize: 16,
    marginBottom: 12,
  },
  providerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    gap: 6,
  },
  providerText: {
    color: '#94a3b8',
    fontSize: 13,
  },
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1e293b',
    padding: 14,
    borderRadius: 8,
    gap: 8,
    marginBottom: 40,
  },
  signOutText: {
    color: '#ef4444',
    fontSize: 16,
    fontWeight: '600',
  },
});
