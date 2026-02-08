import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { AuthProvider } from './src/context/AuthContext';
import { JobProvider } from './src/context/JobContext';
import { FeedProvider } from './src/context/FeedContext';
import TabNavigator from './src/navigation/TabNavigator';

const navigationRef = createNavigationContainerRef();

export default function App() {
  return (
    <AuthProvider>
      <JobProvider navigationRef={navigationRef}>
        <FeedProvider>
          <NavigationContainer ref={navigationRef}>
            <TabNavigator />
            <StatusBar style="light" />
          </NavigationContainer>
        </FeedProvider>
      </JobProvider>
    </AuthProvider>
  );
}
