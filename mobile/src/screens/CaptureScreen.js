import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Animated,
  Dimensions,
  PanResponder,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Line, Circle as SvgCircle } from 'react-native-svg';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useJob } from '../context/JobContext';
import { checkHealth } from '../services/api';
import CameraRecorder from '../components/CameraRecorder';
import UploadingOverlay from '../components/UploadingOverlay';

const { width: SW, height: SH } = Dimensions.get('window');

// ─── Touch-Interactive 3D Wireframe Cube ─────────────────────
// Drag to rotate, flick for momentum, auto-rotates when idle.
// Includes orbiting particles, vertex trails, and crosshair guides.

function InteractiveCube({ size = 160, onInteract }) {
  const rotY = useRef(0);
  const rotX = useRef(0.35);
  const velY = useRef(0.5);
  const velX = useRef(0);
  const touching = useRef(false);
  const lastDx = useRef(0);
  const lastDy = useRef(0);
  const trails = useRef(Array.from({ length: 8 }, () => []));
  const [tick, setTick] = useState(0);

  const TRAIL_LEN = 6;

  useEffect(() => {
    const iv = setInterval(() => {
      if (!touching.current) {
        rotY.current += velY.current * 0.04;
        rotX.current += velX.current * 0.04;
        velY.current += (0.5 - velY.current) * 0.015;
        velX.current *= 0.97;
        rotX.current = Math.max(-1, Math.min(1, rotX.current));
      }
      setTick(t => t + 1);
    }, 40);
    return () => clearInterval(iv);
  }, []);

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 3 || Math.abs(g.dy) > 3,
    onPanResponderGrant: () => {
      touching.current = true;
      lastDx.current = 0;
      lastDy.current = 0;
      onInteract?.();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    },
    onPanResponderMove: (_, g) => {
      const dx = g.dx - lastDx.current;
      const dy = g.dy - lastDy.current;
      lastDx.current = g.dx;
      lastDy.current = g.dy;
      rotY.current += dx * 0.01;
      rotX.current = Math.max(-1.2, Math.min(1.2, rotX.current + dy * 0.006));
    },
    onPanResponderRelease: (_, g) => {
      velY.current = g.vx * 0.5;
      velX.current = g.vy * 0.3;
      touching.current = false;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    },
  })).current;

  const cx = size / 2;
  const cy = size / 2;
  const focal = size * 2.5;
  const s = size * 0.28;

  const cosY = Math.cos(rotY.current);
  const sinY = Math.sin(rotY.current);
  const cosX = Math.cos(rotX.current);
  const sinX = Math.sin(rotX.current);

  const project = (x, y, z) => {
    const x1 = x * cosY - z * sinY;
    const z1 = x * sinY + z * cosY;
    const y2 = y * cosX - z1 * sinX;
    const z2 = y * sinX + z1 * cosX;
    const sc = focal / (focal + z2);
    return { x: cx + x1 * sc, y: cy + y2 * sc, z: z2, sc };
  };

  const verts = [
    [-s,-s,-s],[s,-s,-s],[s,s,-s],[-s,s,-s],
    [-s,-s,s],[s,-s,s],[s,s,s],[-s,s,s],
  ];
  const projected = verts.map(v => project(...v));

  // Update vertex trails
  projected.forEach((p, i) => {
    trails.current[i].push({ x: p.x, y: p.y });
    if (trails.current[i].length > TRAIL_LEN) trails.current[i].shift();
  });

  const edges = [
    [0,1],[1,2],[2,3],[3,0],
    [4,5],[5,6],[6,7],[7,4],
    [0,4],[1,5],[2,6],[3,7],
  ];

  // Orbiting particles
  const particles = useMemo(() =>
    Array.from({ length: 14 }, () => ({
      theta: Math.random() * Math.PI * 2,
      phi: 0.3 + Math.random() * 2.4,
      r: s * (1.4 + Math.random() * 1.2),
      size: 1 + Math.random() * 1.5,
      speed: 0.2 + Math.random() * 0.6,
    })), [s]);

  const orbiting = particles.map(p => {
    const a = rotY.current * p.speed + p.theta;
    return project(
      p.r * Math.cos(a) * Math.sin(p.phi),
      p.r * Math.cos(p.phi),
      p.r * Math.sin(a) * Math.sin(p.phi),
    );
  });

  return (
    <View {...pan.panHandlers} style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        {/* Crosshair + targeting rings */}
        <Line x1={0} y1={cy} x2={size} y2={cy} stroke="#1e293b" strokeWidth={0.5} />
        <Line x1={cx} y1={0} x2={cx} y2={size} stroke="#1e293b" strokeWidth={0.5} />
        <SvgCircle cx={cx} cy={cy} r={size * 0.18} stroke="#1e293b" strokeWidth={0.5} fill="none" />
        <SvgCircle cx={cx} cy={cy} r={size * 0.38} stroke="rgba(30,41,59,0.25)" strokeWidth={0.3} fill="none" />

        {/* Vertex trails */}
        {trails.current.map((trail, vi) =>
          trail.map((t, ti) => (
            <SvgCircle key={`t${vi}-${ti}`}
              cx={t.x} cy={t.y} r={0.8}
              fill="#3b82f6" opacity={0.02 + (ti / TRAIL_LEN) * 0.12}
            />
          ))
        )}

        {/* Orbiting particles */}
        {orbiting.map((p, i) => {
          const depth = (p.z + s * 2) / (4 * s);
          return (
            <SvgCircle key={`o${i}`}
              cx={p.x} cy={p.y}
              r={particles[i].size * Math.max(0.4, depth)}
              fill="#60a5fa" opacity={0.06 + 0.28 * Math.max(0, depth)}
            />
          );
        })}

        {/* Cube edges */}
        {edges.map(([a, b], i) => {
          const pa = projected[a];
          const pb = projected[b];
          const depth = ((pa.z + pb.z) / 2 + s) / (2 * s);
          return (
            <Line key={`e${i}`}
              x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
              stroke="#3b82f6" strokeWidth={1.2}
              opacity={Math.min(0.85, Math.max(0.06, 0.06 + 0.7 * depth))}
            />
          );
        })}

        {/* Cube vertices */}
        {projected.map((p, i) => {
          const depth = (p.z + s) / (2 * s);
          return (
            <SvgCircle key={`v${i}`}
              cx={p.x} cy={p.y} r={2 + 2 * depth}
              fill="#93c5fd" opacity={0.15 + 0.8 * depth}
            />
          );
        })}
      </Svg>
    </View>
  );
}

// ─── Expanding Pulse Rings ───────────────────────────────────

function PulseRing({ delay, center }) {
  const scale = useRef(new Animated.Value(0.3)).current;
  const opacity = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.parallel([
          Animated.timing(scale, { toValue: 2.8, duration: 3000, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0, duration: 3000, useNativeDriver: true }),
        ]),
        Animated.parallel([
          Animated.timing(scale, { toValue: 0.3, duration: 0, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.35, duration: 0, useNativeDriver: true }),
        ]),
      ])
    ).start();
  }, []);

  return (
    <Animated.View style={{
      position: 'absolute',
      width: 60, height: 60, borderRadius: 30,
      left: center - 30, top: center - 30,
      borderWidth: 1, borderColor: '#3b82f6',
      transform: [{ scale }], opacity,
    }} />
  );
}

// ─── Drifting Dot Field ──────────────────────────────────────

function DriftDot({ x, y, size, opacity, dx, dy, dur }) {
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.parallel([
        Animated.timing(tx, { toValue: dx, duration: dur, useNativeDriver: true }),
        Animated.timing(ty, { toValue: dy, duration: dur, useNativeDriver: true }),
      ]),
      Animated.parallel([
        Animated.timing(tx, { toValue: 0, duration: dur, useNativeDriver: true }),
        Animated.timing(ty, { toValue: 0, duration: dur, useNativeDriver: true }),
      ]),
    ])).start();
  }, []);

  return (
    <Animated.View style={{
      position: 'absolute', left: x, top: y,
      width: size, height: size, borderRadius: size,
      backgroundColor: '#93c5fd', opacity,
      transform: [{ translateX: tx }, { translateY: ty }],
    }} />
  );
}

function DotField() {
  const data = useMemo(() => {
    const out = [];
    for (let i = 0; i < 30; i++) {
      const drifts = i < 12;
      out.push({
        x: Math.random() * SW,
        y: Math.random() * SH,
        size: 1 + Math.random() * (drifts ? 2 : 1.5),
        opacity: drifts ? 0.04 + Math.random() * 0.08 : 0.02 + Math.random() * 0.05,
        drifts,
        dx: (Math.random() - 0.5) * 40,
        dy: (Math.random() - 0.5) * 30,
        dur: 4000 + Math.random() * 6000,
      });
    }
    return out;
  }, []);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {data.map((d, i) => d.drifts ? (
        <DriftDot key={i} {...d} />
      ) : (
        <View key={i} style={{
          position: 'absolute', left: d.x, top: d.y,
          width: d.size, height: d.size, borderRadius: d.size,
          backgroundColor: '#93c5fd', opacity: d.opacity,
        }} />
      ))}
    </View>
  );
}

// ─── Dual Scan Lines ─────────────────────────────────────────

function ScanLine({ delay, duration, lineOpacity, glow }) {
  const ty = useRef(new Animated.Value(-10)).current;

  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.delay(delay),
      Animated.timing(ty, { toValue: SH + 10, duration, useNativeDriver: true }),
      Animated.timing(ty, { toValue: -10, duration: 0, useNativeDriver: true }),
    ])).start();
  }, []);

  return (
    <Animated.View pointerEvents="none" style={{
      position: 'absolute', left: 0, right: 0, height: 1,
      backgroundColor: `rgba(59,130,246,${lineOpacity})`,
      transform: [{ translateY: ty }],
      shadowColor: '#3b82f6',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: lineOpacity * 6, shadowRadius: glow,
    }} />
  );
}

// ─── Glitch Text ─────────────────────────────────────────────

function GlitchText({ children, style }) {
  const offsetX = useRef(new Animated.Value(0)).current;
  const glitchOp = useRef(new Animated.Value(1)).current;
  const timer = useRef(null);
  const alive = useRef(true);

  useEffect(() => {
    const schedule = () => {
      timer.current = setTimeout(() => {
        if (!alive.current) return;
        Animated.sequence([
          Animated.parallel([
            Animated.timing(offsetX, { toValue: 6, duration: 50, useNativeDriver: true }),
            Animated.timing(glitchOp, { toValue: 0.3, duration: 50, useNativeDriver: true }),
          ]),
          Animated.parallel([
            Animated.timing(offsetX, { toValue: -4, duration: 35, useNativeDriver: true }),
            Animated.timing(glitchOp, { toValue: 0.7, duration: 35, useNativeDriver: true }),
          ]),
          Animated.parallel([
            Animated.timing(offsetX, { toValue: 3, duration: 40, useNativeDriver: true }),
            Animated.timing(glitchOp, { toValue: 0.5, duration: 40, useNativeDriver: true }),
          ]),
          Animated.parallel([
            Animated.timing(offsetX, { toValue: -1, duration: 30, useNativeDriver: true }),
            Animated.timing(glitchOp, { toValue: 0.9, duration: 30, useNativeDriver: true }),
          ]),
          Animated.parallel([
            Animated.timing(offsetX, { toValue: 0, duration: 25, useNativeDriver: true }),
            Animated.timing(glitchOp, { toValue: 1, duration: 25, useNativeDriver: true }),
          ]),
        ]).start(() => { if (alive.current) schedule(); });
      }, 3000 + Math.random() * 5000);
    };
    schedule();
    return () => { alive.current = false; clearTimeout(timer.current); };
  }, []);

  return (
    <Animated.Text style={[style, {
      transform: [{ translateX: offsetX }], opacity: glitchOp,
    }]}>
      {children}
    </Animated.Text>
  );
}

// ─── Pressable Card (spring scale + haptics) ─────────────────

function PressableCard({ onPress, disabled, children, style }) {
  const scale = useRef(new Animated.Value(1)).current;
  return (
    <TouchableOpacity
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        onPress?.();
      }}
      onPressIn={() => Animated.spring(scale, { toValue: 0.965, useNativeDriver: true, friction: 8 }).start()}
      onPressOut={() => Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 6 }).start()}
      disabled={disabled} activeOpacity={1}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>
        {children}
      </Animated.View>
    </TouchableOpacity>
  );
}

// ─── Shimmer Sweep on Record Card ────────────────────────────

function Shimmer() {
  const tx = useRef(new Animated.Value(-SW)).current;

  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.delay(5000),
      Animated.timing(tx, { toValue: SW, duration: 1200, useNativeDriver: true }),
      Animated.timing(tx, { toValue: -SW, duration: 0, useNativeDriver: true }),
    ])).start();
  }, []);

  return (
    <Animated.View pointerEvents="none" style={{
      ...StyleSheet.absoluteFillObject,
      transform: [{ translateX: tx }],
    }}>
      <LinearGradient
        colors={['transparent', 'rgba(255,255,255,0.035)', 'transparent']}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
        style={{ width: 120, height: '100%' }}
      />
    </Animated.View>
  );
}

// ─── Pipeline with Sequential Glow ───────────────────────────

function PipelineTrack({ animValue }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.timing(pulse, { toValue: 3, duration: 4000, useNativeDriver: false })
    ).start();
  }, []);

  const steps = [
    { num: '1', label: 'CAPTURE' },
    { num: '2', label: 'PROCESS' },
    { num: '3', label: 'VIEW' },
  ];

  return (
    <Animated.View style={[styles.pipeline, { opacity: animValue }]}>
      {steps.map((step, i) => {
        const borderColor = pulse.interpolate({
          inputRange: [Math.max(0, i - 0.5), i, Math.min(3, i + 0.5)],
          outputRange: ['rgba(59,130,246,0.2)', 'rgba(59,130,246,0.7)', 'rgba(59,130,246,0.2)'],
          extrapolate: 'clamp',
        });
        const bgColor = pulse.interpolate({
          inputRange: [Math.max(0, i - 0.5), i, Math.min(3, i + 0.5)],
          outputRange: ['rgba(59,130,246,0.04)', 'rgba(59,130,246,0.18)', 'rgba(59,130,246,0.04)'],
          extrapolate: 'clamp',
        });

        return (
          <React.Fragment key={i}>
            <View style={styles.pipelineNode}>
              <Animated.View style={[styles.pipelineCircle, { borderColor, backgroundColor: bgColor }]}>
                <Text style={styles.pipelineNum}>{step.num}</Text>
              </Animated.View>
              <Text style={styles.pipelineLabel}>{step.label}</Text>
            </View>
            {i < steps.length - 1 && <View style={styles.pipelineLine} />}
          </React.Fragment>
        );
      })}
    </Animated.View>
  );
}

// ═══════════════════════════════════════════════════════════════

export default function CaptureScreen() {
  const { startUpload, isUploading, uploadError, uploadProgress } = useJob();
  const [showCamera, setShowCamera] = useState(false);
  const [serverOnline, setServerOnline] = useState(null);
  const [hasInteracted, setHasInteracted] = useState(false);
  const intervalRef = useRef(null);

  // Staggered entrance
  const animCube = useRef(new Animated.Value(0)).current;
  const animTitle = useRef(new Animated.Value(0)).current;
  const animPipeline = useRef(new Animated.Value(0)).current;
  const animCards = useRef(new Animated.Value(0)).current;
  const hintPulse = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    Animated.stagger(130, [
      Animated.timing(animCube, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(animTitle, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(animPipeline, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.timing(animCards, { toValue: 1, duration: 500, useNativeDriver: true }),
    ]).start();
  }, []);

  useEffect(() => {
    if (!hasInteracted) {
      const loop = Animated.loop(Animated.sequence([
        Animated.timing(hintPulse, { toValue: 0.8, duration: 1200, useNativeDriver: true }),
        Animated.timing(hintPulse, { toValue: 0.3, duration: 1200, useNativeDriver: true }),
      ]));
      loop.start();
      return () => loop.stop();
    }
  }, [hasInteracted]);

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
    if (uploadError) Alert.alert('Upload Failed', uploadError);
  }, [uploadError]);

  if (showCamera) {
    return (
      <CameraRecorder
        onVideoRecorded={handleVideoRecorded}
        onCancel={() => setShowCamera(false)}
      />
    );
  }

  const slideUp = (v) => ({
    opacity: v,
    transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
  });

  const CUBE_SIZE = 160;

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={['#060a13', '#0d1526', '#060a13']}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
      />
      <DotField />
      <ScanLine delay={0} duration={5000} lineOpacity={0.06} glow={30} />
      <ScanLine delay={2500} duration={7000} lineOpacity={0.03} glow={15} />

      {isUploading && <UploadingOverlay progress={uploadProgress} />}

      {serverOnline !== null && (
        <View style={styles.statusWrap}>
          <View style={styles.statusPill}>
            <View style={[styles.statusDot,
              { backgroundColor: serverOnline ? '#22c55e' : '#ef4444' }]} />
            <Text style={styles.statusText}>
              {serverOnline ? 'Connected' : 'Offline'}
            </Text>
          </View>
        </View>
      )}

      <View style={styles.content}>
        {/* Hero cube + pulse rings */}
        <Animated.View style={[styles.cubeArea, slideUp(animCube)]}>
          <View style={styles.cubeGlow} />
          <PulseRing delay={0} center={CUBE_SIZE / 2} />
          <PulseRing delay={1500} center={CUBE_SIZE / 2} />
          <InteractiveCube size={CUBE_SIZE} onInteract={() => setHasInteracted(true)} />
          {!hasInteracted && (
            <Animated.Text style={[styles.hint, { opacity: hintPulse }]}>
              Drag to rotate
            </Animated.Text>
          )}
        </Animated.View>

        {/* Title */}
        <Animated.View style={[styles.titleWrap, slideUp(animTitle)]}>
          <Text style={styles.titleSub}>Create a</Text>
          <GlitchText style={styles.titleMain}>3D Splat</GlitchText>
          <Text style={styles.subtitle}>
            Walk around any object with your camera.{'\n'}
            We'll turn it into an interactive 3D model.
          </Text>
        </Animated.View>

        <PipelineTrack animValue={animPipeline} />

        {/* Action cards */}
        <Animated.View style={[styles.cardsArea, slideUp(animCards)]}>
          <PressableCard
            onPress={() => setShowCamera(true)}
            disabled={isUploading}
            style={styles.recordCard}
          >
            <LinearGradient
              colors={['#122040', '#0f1a30']}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={styles.recordInner}
            >
              <Shimmer />
              <View style={styles.recRing}>
                <View style={styles.recDot} />
              </View>
              <View style={styles.cardText}>
                <Text style={styles.recTitle}>Record Video</Text>
                <Text style={styles.recDesc}>Open camera and capture your object</Text>
              </View>
              <Ionicons name="arrow-forward" size={18} color="#3b82f6" />
            </LinearGradient>
          </PressableCard>

          <PressableCard
            onPress={handlePickVideo}
            disabled={isUploading}
            style={styles.galleryCard}
          >
            <View style={styles.galleryAccent} />
            <Ionicons name="images-outline" size={20} color="#475569" style={{ marginRight: 12 }} />
            <Text style={styles.galleryTitle}>Choose from gallery</Text>
            <View style={{ flex: 1 }} />
            <Ionicons name="arrow-forward" size={16} color="#334155" />
          </PressableCard>
        </Animated.View>
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#060a13' },

  content: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 24, paddingBottom: 16,
  },

  /* Status */
  statusWrap: { position: 'absolute', top: 56, right: 20, zIndex: 10 },
  statusPill: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(6,10,19,0.9)',
    paddingHorizontal: 12, paddingVertical: 5,
    borderRadius: 20, borderWidth: 1, borderColor: '#1e293b',
  },
  statusDot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  statusText: { color: '#64748b', fontSize: 11, fontWeight: '600', letterSpacing: 0.3 },

  /* Cube area */
  cubeArea: {
    width: 160, height: 185,
    alignItems: 'center', justifyContent: 'flex-start',
    marginBottom: 20,
  },
  cubeGlow: {
    position: 'absolute', width: 220, height: 220, borderRadius: 110,
    backgroundColor: '#0f2847', opacity: 0.35,
    top: -30, left: -30,
  },
  hint: {
    color: '#475569', fontSize: 11, fontWeight: '500',
    letterSpacing: 0.5, marginTop: 8,
  },

  /* Title */
  titleWrap: { alignItems: 'center', marginBottom: 20 },
  titleSub: { color: '#475569', fontSize: 15, fontWeight: '400', marginBottom: 2 },
  titleMain: {
    color: '#f1f5f9', fontSize: 42, fontWeight: '800',
    letterSpacing: -1.5, marginBottom: 10,
  },
  subtitle: { color: '#3f4f63', fontSize: 13, textAlign: 'center', lineHeight: 19 },

  /* Pipeline */
  pipeline: {
    flexDirection: 'row', alignItems: 'flex-start',
    marginBottom: 28, width: '100%', paddingHorizontal: 20,
  },
  pipelineNode: { alignItems: 'center' },
  pipelineCircle: {
    width: 30, height: 30, borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center', justifyContent: 'center', marginBottom: 5,
  },
  pipelineNum: { color: '#3b82f6', fontSize: 12, fontWeight: '700' },
  pipelineLabel: { color: '#3f4f63', fontSize: 9, fontWeight: '700', letterSpacing: 1.2 },
  pipelineLine: {
    height: 1, flex: 1,
    backgroundColor: 'rgba(59,130,246,0.1)',
    marginTop: 15, marginHorizontal: 10,
  },

  /* Cards */
  cardsArea: { width: '100%' },

  recordCard: {
    borderRadius: 16, overflow: 'hidden', marginBottom: 10,
    borderWidth: 1, borderColor: 'rgba(59,130,246,0.1)',
  },
  recordInner: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 18, paddingVertical: 20,
    overflow: 'hidden',
  },
  recRing: {
    width: 46, height: 46, borderRadius: 23,
    borderWidth: 1.5, borderColor: 'rgba(59,130,246,0.3)',
    alignItems: 'center', justifyContent: 'center', marginRight: 14,
  },
  recDot: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#3b82f6' },
  cardText: { flex: 1 },
  recTitle: { color: '#e2e8f0', fontSize: 16, fontWeight: '700', marginBottom: 2 },
  recDesc: { color: '#3f4f63', fontSize: 12 },

  galleryCard: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 18, paddingVertical: 16,
    borderRadius: 14, backgroundColor: 'rgba(10,15,28,0.7)',
    borderWidth: 1, borderColor: '#1a2438', overflow: 'hidden',
  },
  galleryAccent: {
    position: 'absolute', left: 0, top: 10, bottom: 10,
    width: 3, borderRadius: 1.5, backgroundColor: '#1e3a5f',
  },
  galleryTitle: { color: '#7b8ba3', fontSize: 14, fontWeight: '600' },
});
