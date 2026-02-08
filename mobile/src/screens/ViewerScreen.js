import React, { useRef, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { RENDERER_URL } from '../config';
import { useJob } from '../context/JobContext';
import ProgressBar from '../components/ProgressBar';

export default function ViewerScreen() {
  const webViewRef = useRef(null);
  const { activeJobId, jobStatus } = useJob();

  const webViewUrl = useMemo(() => {
    if (activeJobId && jobStatus?.status === 'completed') {
      return `${RENDERER_URL}?url=/jobs/${activeJobId}/output.splat`;
    }
    return RENDERER_URL;
  }, [activeJobId, jobStatus?.status]);

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ uri: webViewUrl }}
        style={styles.webview}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="always"
        androidLayerType="hardware"
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        originWhitelist={['*']}
      />
      <View style={styles.overlay} pointerEvents="box-none">
        <ProgressBar />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  webview: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
});
