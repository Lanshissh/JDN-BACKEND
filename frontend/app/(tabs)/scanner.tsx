import {
  OnSuccessfulScanProps,
  QRCodeScanner,
} from "@masumdev/rn-qrcode-scanner";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useState, useRef } from "react";
import {
  Alert,
  Image,
  StyleSheet,
  Text,
  View,
  Platform,
  Animated,
  Vibration,
} from "react-native";

export default function ScannerScreen() {
  const router = useRouter();
  const [scanned, setScanned] = useState(false);
  const [scannerKey, setScannerKey] = useState(0);

  const handleScan = (data: OnSuccessfulScanProps) => {
    if (scanned) return;
    setScanned(true);

    if (Platform.OS !== "web") {
      Vibration.vibrate(100);
    }

    const raw = String(
      (data as any)?.code ??
        (data as any)?.rawData ??
        (data as any)?.data ??
        ""
    ).trim();

    if (!raw) {
      Alert.alert("QR code empty", "No data found in QR code.");
      setTimeout(() => setScanned(false), 1000);
      return;
    }

    const meterIdPattern = /^MTR-[A-Za-z0-9-]+$/i;
    if (!meterIdPattern.test(raw)) {
      Alert.alert("Invalid QR", "QR code does not contain a valid meter ID.");
      setTimeout(() => setScanned(false), 1000);
      return;
    }

    const meterId = raw.toUpperCase();

    router.replace({
      pathname: "/(tabs)/admin",
      params: { panel: "readings", meterId },
    } as any);

    Alert.alert("Success!", `Meter ${meterId} scanned`);
    setTimeout(() => setScanned(false), 1000);
  };

  useFocusEffect(
    React.useCallback(() => {
      setScannerKey((prev) => prev + 1);
      setScanned(false);
    }, [])
  );

  return (
    <View style={styles.container}>
      <QRCodeScanner
        key={scannerKey}
        core={{ onSuccessfulScan: handleScan }}
        scanning={{ cooldownDuration: 500 }}
        uiControls={{
          showControls: true,
          showTorchButton: true,
          showStatus: false,
        }}
        permissionScreen={{}}
      />

      <View pointerEvents="none" style={styles.topGradient}>
        <View style={styles.logoContainer}>
          <Image
            source={require("../../assets/images/logo.png")}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.appTitle}>QR Scanner</Text>
        </View>
      </View>

      <View pointerEvents="none" style={styles.bottomGradient}>
        <View style={styles.instructionsContainer}>
          <Text style={styles.instructionTitle}>Scan Meter QR Code</Text>
          <Text style={styles.instructionText}>
            Position the QR code within the frame
          </Text>
          {Platform.OS === "web" && (
            <Text style={styles.instructionHint}>
              Press CTRL/CMD + Plus to zoom if needed
            </Text>
          )}
        </View>
      </View>

      {scanned && (
        <View pointerEvents="none" style={styles.statusIndicator}>
          <View style={styles.statusBadge}>
            <Text style={styles.statusText}>✓ Scanned</Text>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  topGradient: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 200,
    backgroundColor: "rgba(0,0,0,0.8)",
    zIndex: 10,
  },
  logoContainer: {
    marginTop: 50,
    alignItems: "center",
  },
  logo: {
    width: 80,
    height: 80,
    marginBottom: 8,
  },
  appTitle: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  bottomGradient: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 200,
    backgroundColor: "rgba(0,0,0,0.8)",
    justifyContent: "flex-end",
    paddingBottom: 40,
    zIndex: 10,
  },
  instructionsContainer: {
    alignItems: "center",
    paddingHorizontal: 20,
  },
  instructionTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 8,
  },
  instructionText: {
    color: "#d1d5db",
    fontSize: 14,
    textAlign: "center",
    opacity: 0.9,
  },
  instructionHint: {
    marginTop: 8,
    color: "#9ca3af",
    fontSize: 12,
    textAlign: "center",
    opacity: 0.8,
  },
  statusIndicator: {
    position: "absolute",
    top: "50%",
    left: 0,
    right: 0,
    alignItems: "center",
    marginTop: 50,
    zIndex: 15,
  },
  statusBadge: {
    backgroundColor: "#10b981",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
    shadowColor: "#10b981",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  statusText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});