import React, { useEffect, useRef, useState } from "react";
import { View, StyleSheet, Platform, Modal, Text, TouchableOpacity } from "react-native";
import { Slot, useRouter, Tabs } from "expo-router";
import SideNav, { TabKey } from "../../components/SideNav";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../contexts/AuthContext";
const IDLE_LIMIT_MS = 60 * 60 * 1000;
const WARN_BEFORE_MS = 2 * 60 * 1000;
function IdleSessionGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { logout } = useAuth();
  const [warnVisible, setWarnVisible] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(Math.round(WARN_BEFORE_MS / 1000));
  const warnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clearAll = () => {
    if (warnTimerRef.current) clearTimeout(warnTimerRef.current);
    if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current);
    if (tickerRef.current) clearInterval(tickerRef.current);
    warnTimerRef.current = null;
    logoutTimerRef.current = null;
    tickerRef.current = null;
  };
  const scheduleAll = () => {
    clearAll();
    const msToWarn = Math.max(0, IDLE_LIMIT_MS - WARN_BEFORE_MS);
    warnTimerRef.current = setTimeout(() => {
      setSecondsLeft(Math.round(WARN_BEFORE_MS / 1000));
      setWarnVisible(true);
      tickerRef.current = setInterval(() => {
        setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
      }, 1000);
    }, msToWarn);
    logoutTimerRef.current = setTimeout(async () => {
      clearAll();
      setWarnVisible(false);
      try {
        await logout();
      } finally {
        router.replace("/(auth)/login");
      }
    }, IDLE_LIMIT_MS);
  };
  const onActivity = () => {
    setWarnVisible(false);
    scheduleAll();
  };
  useEffect(() => {
    scheduleAll();
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const handleActivity = () => onActivity();
      const onVisible = () => {
        if (typeof document !== "undefined" && document.visibilityState === "visible") {
          onActivity();
        }
      };
      const winEvents: (keyof WindowEventMap)[] = [
        "mousemove",
        "mousedown",
        "keydown",
        "scroll",
        "touchstart",
        "focus",
      ];
      winEvents.forEach((ev) => window.addEventListener(ev, handleActivity as EventListener, { passive: true } as any));
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        clearAll();
        winEvents.forEach((ev) => window.removeEventListener(ev, handleActivity as EventListener));
        document.removeEventListener("visibilitychange", onVisible);
      };
    }
    return () => clearAll();
  }, []);
  useEffect(() => {
    if (!warnVisible && tickerRef.current) {
      clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
  }, [warnVisible]);
  return (
    <View style={{ flex: 1 }} onTouchStart={onActivity}>
      {children}
      <Modal visible={warnVisible} animationType="fade" transparent>
        <View style={styles.promptOverlay}>
          <View style={styles.promptCard}>
            <Text style={styles.promptTitle}>Idle session will expire!</Text>
            <Text style={styles.promptBody}>
              Your session will expire in {secondsLeft} second{secondsLeft === 1 ? "" : "s"} due to inactivity!
              {"\n"}Do you want to break the timeout?
            </Text>
            <View style={styles.promptActions}>
              <TouchableOpacity
                onPress={() => setWarnVisible(false)}
                style={[styles.promptBtn, styles.promptBtnGhost]}
              >
                <Text style={styles.promptBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={onActivity} style={styles.promptBtn}>
                <Text style={styles.promptBtnText}>OK</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
export default function TabLayout() {
  const [activeTab, setActiveTab] = useState<TabKey>("admin");
  const router = useRouter();
  const { logout } = useAuth();
  const handleSelectTab = async (tab: TabKey) => {
    setActiveTab(tab);
    if (tab === "logout") {
      await logout();
      router.replace("/(auth)/login");
    } else {
      router.replace(`/(tabs)/${tab}` as any);
    }
  };
  if (Platform.OS === "web") {
    return (
      <IdleSessionGuard>
        <View style={styles.container}>
          <SideNav active={activeTab} onSelect={handleSelectTab} />
          <View style={styles.content}>
            <Slot />
          </View>
        </View>
      </IdleSessionGuard>
    );
  }
  return (
    <IdleSessionGuard>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: "#fff",
          tabBarInactiveTintColor: "#fff",
          tabBarStyle: {
            backgroundColor: "#007bff",
            borderTopWidth: 1,
            borderTopColor: "#eee",
          },
        }}
      >
        <Tabs.Screen
          name="admin"
          options={{
            title: "Admin",
            tabBarIcon: ({ color, focused }) => (
              <TabBarIcon name={focused ? "person-circle" : "person-circle-outline"} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="scanner"
          options={{
            title: "Scanner",
            tabBarIcon: ({ color, focused }) => (
              <TabBarIcon name={focused ? "scan" : "scan-outline"} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="billing"
          options={{
            title: "Billing",
            tabBarIcon: ({ color, focused }) => (
              <TabBarIcon name={focused ? "card" : "card-outline"} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="dashboard"
          options={{
            title: "Dashboard",
            tabBarIcon: ({ color, focused }) => (
              <TabBarIcon name={focused ? "grid" : "grid-outline"} color={color} />
            ),
          }}
        />
      </Tabs>
    </IdleSessionGuard>
  );
}
function TabBarIcon({ name, color }: { name: string; color: string }) {
  return <Ionicons name={name as any} size={24} color={color} />;
}
const styles = StyleSheet.create({
  container: { flex: 1, flexDirection: "row", backgroundColor: "#f9f9f9" },
  content: { flex: 1 },
  promptOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  promptCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 16,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  promptTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#102a43",
    marginBottom: 8,
  },
  promptBody: {
    fontSize: 14,
    color: "#334e68",
    lineHeight: 20,
    marginBottom: 14,
  },
  promptActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  promptBtn: {
    backgroundColor: "#007bff",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    marginLeft: 10, 
  },
  promptBtnText: {
    color: "#fff",
    fontWeight: "700",
  },
  promptBtnGhost: {
    backgroundColor: "#e6efff",
  },
  promptBtnGhostText: {
    color: "#1f3a8a",
    fontWeight: "700",
  },
});