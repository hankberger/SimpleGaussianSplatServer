import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import AuthModal from '../components/AuthModal';

const DISCORD_URL = 'https://discord.gg/YOUR_INVITE'; // TODO: replace with real invite

function MenuRow({ icon, label, onPress, color = '#f1f5f9', iconColor = '#94a3b8' }) {
  return (
    <TouchableOpacity style={styles.menuRow} onPress={onPress} activeOpacity={0.6}>
      <View style={styles.menuRowLeft}>
        <Ionicons name={icon} size={20} color={iconColor} />
        <Text style={[styles.menuRowLabel, { color }]}>{label}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color="#334155" />
    </TouchableOpacity>
  );
}

export default function ProfileScreen() {
  const { user, isAuthenticated, logout } = useAuth();
  const [showAuth, setShowAuth] = useState(false);

  const providerLabel = isAuthenticated
    ? ({ email: 'Email', google: 'Google', apple: 'Apple' }[user.provider] || user.provider)
    : null;

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Profile header */}
        <View style={styles.header}>
          <View style={styles.avatar}>
            <Ionicons
              name={isAuthenticated ? 'person' : 'person-outline'}
              size={40}
              color={isAuthenticated ? '#64748b' : '#475569'}
            />
          </View>

          {isAuthenticated ? (
            <>
              <Text style={styles.displayName}>{user.display_name || 'User'}</Text>
              <Text style={styles.email}>{user.email}</Text>
              <View style={styles.providerBadge}>
                <Ionicons
                  name={user.provider === 'apple' ? 'logo-apple' : user.provider === 'google' ? 'logo-google' : 'mail-outline'}
                  size={14}
                  color="#94a3b8"
                />
                <Text style={styles.providerText}>Signed in with {providerLabel}</Text>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.displayName}>Not signed in</Text>
              <Text style={styles.subtitle}>Sign in to upload videos and save your likes</Text>
              <TouchableOpacity style={styles.signInButton} onPress={() => setShowAuth(true)}>
                <Text style={styles.signInText}>Sign In / Sign Up</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Menu */}
        <View style={styles.menuSection}>
          <MenuRow
            icon="logo-discord"
            label="Join the Discord community"
            iconColor="#5865F2"
            onPress={() => Linking.openURL(DISCORD_URL)}
          />
          <MenuRow
            icon="settings-outline"
            label="Settings"
            onPress={() => {/* TODO: navigate to settings */}}
          />
        </View>

        {/* Sign out */}
        {isAuthenticated && (
          <View style={styles.menuSection}>
            <MenuRow
              icon="log-out-outline"
              label="Sign Out"
              color="#ef4444"
              iconColor="#ef4444"
              onPress={logout}
            />
          </View>
        )}
      </ScrollView>

      <AuthModal visible={showAuth} onClose={() => setShowAuth(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0f1a',
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  header: {
    alignItems: 'center',
    paddingTop: 80,
    paddingBottom: 32,
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
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 4,
  },
  email: {
    color: '#94a3b8',
    fontSize: 15,
    marginBottom: 12,
  },
  subtitle: {
    color: '#64748b',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 20,
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
  signInButton: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
  },
  signInText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  menuSection: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 16,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#334155',
  },
  menuRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  menuRowLabel: {
    fontSize: 16,
  },
});
