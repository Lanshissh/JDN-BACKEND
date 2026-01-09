import React, { useEffect, useMemo, useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Platform,
  TouchableOpacity,
  Pressable,
  useWindowDimensions,
  ScrollView,
  Animated,
} from "react-native";
import axios, { AxiosError } from "axios";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { BASE_API } from "../../constants/api";
import { useAuth } from "../../contexts/AuthContext";
type CountKey = "buildings" | "tenants" | "stalls" | "meters" | "readings";
type Role = "admin" | "operator" | "biller" | "unknown";
type Counts = Partial<Record<CountKey, number>>;
type TileState = {
  label: string;
  key: CountKey;
  color: string;
  icon: keyof typeof Ionicons.glyphMap;
  restricted?: boolean;
};
function decodeRole(token: string | null): { role: Role; buildingId?: string } {
  if (!token) return { role: "unknown" };
  try {
    const base64Url = token.split(".")[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join(""),
    );
    const payload = JSON.parse(jsonPayload);
    const role = String(payload.user_level || payload.role || "unknown").toLowerCase() as Role;
    const buildingId = payload.building_id || payload.buildingId || undefined;
    if (role === "admin" || role === "operator" || role === "biller") return { role, buildingId };
    return { role: "unknown" };
  } catch {
    return { role: "unknown" };
  }
}
function makeApi(token: string | null) {
  const api = axios.create({ baseURL: BASE_API });
  api.interceptors.request.use((cfg) => {
    if (token) cfg.headers.Authorization = `Bearer ${token}`;
    return cfg;
  });
  return api;
}
async function safeCount(
  api: ReturnType<typeof makeApi>,
  path: string,
): Promise<{ count?: number; restricted?: boolean }> {
  try {
    const res = await api.get(path);
    const data = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.rows) ? res.data.rows : [];
    return { count: data.length };
  } catch (e) {
    const err = e as AxiosError;
    if (err.response && (err.response.status === 401 || err.response.status === 403)) {
      return { restricted: true };
    }
    return { count: 0 };
  }
}
function MetricCard({ 
  tile, 
  count, 
  isRestricted, 
  onPress 
}: { 
  tile: TileState; 
  count: number; 
  isRestricted: boolean;
  onPress: () => void;
}) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.98,
      useNativeDriver: true,
    }).start();
  };
  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      friction: 3,
      tension: 40,
      useNativeDriver: true,
    }).start();
  };
  return (
    <Pressable
      onPress={() => !isRestricted && onPress()}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={isRestricted}
    >
      <Animated.View 
        style={[
          styles.metricCard,
          { transform: [{ scale: scaleAnim }] }
        ]}
      >
        <View style={styles.metricHeader}>
          <View style={[styles.iconContainer, { backgroundColor: tile.color + '15' }]}>
                            <Ionicons name={tile.icon} size={28} color={tile.color} />
          </View>
          {!isRestricted && (
            <View style={styles.statusBadge}>
              <View style={[styles.statusDot, { backgroundColor: '#10b981' }]} />
              <Text style={styles.statusText}>Active</Text>
            </View>
          )}
        </View>
        <View style={styles.metricBody}>
          <Text style={styles.metricLabel}>{tile.label}</Text>
          <Text style={styles.metricValue}>
            {isRestricted ? "—" : count.toLocaleString()}
          </Text>
          <Text style={styles.metricSubtext}>
            {isRestricted ? "Access restricted" : "Total entries"}
          </Text>
        </View>
        {!isRestricted && (
          <View style={styles.metricFooter}>
            <Text style={[styles.viewDetailsText, { color: tile.color }]}>View Details</Text>
            <Ionicons name="arrow-forward" size={16} color={tile.color} />
          </View>
        )}
        {isRestricted && (
          <View style={styles.restrictedOverlay}>
            <Ionicons name="lock-closed" size={16} color="#94a3b8" />
          </View>
        )}
      </Animated.View>
    </Pressable>
  );
}
function QuickActionButton({ 
  icon, 
  label, 
  onPress, 
  variant = "secondary" 
}: { 
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary";
}) {
  const isPrimary = variant === "primary";
  return (
    <TouchableOpacity 
      style={[styles.actionButton, isPrimary && styles.actionButtonPrimary]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={[styles.actionIcon, isPrimary && styles.actionIconPrimary]}>
        <Ionicons 
          name={icon} 
          size={20} 
          color={isPrimary ? "#ffffff" : "#64748b"} 
        />
      </View>
      <Text style={[styles.actionLabel, isPrimary && styles.actionLabelPrimary]}>
        {label}
      </Text>
      {isPrimary && (
        <Ionicons name="chevron-forward" size={16} color="#ffffff" />
      )}
    </TouchableOpacity>
  );
}
export default function Dashboard() {
  const router = useRouter();
  const { token } = useAuth();
  const { width } = useWindowDimensions();
  const { role } = useMemo(() => decodeRole(token), [token]);
  const api = useMemo(() => makeApi(token), [token]);
  const [busy, setBusy] = useState(true);
  const [counts, setCounts] = useState<Counts>({});
  const [restrictions, setRestrictions] = useState<Record<CountKey, boolean>>({
    buildings: false,
    tenants: false,
    stalls: false,
    meters: false,
    readings: false,
  });
  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 600,
      useNativeDriver: true,
    }).start();
  }, []);
  const wantedTiles: TileState[] = useMemo(() => {
    const base: TileState[] = [
      { key: "buildings", label: "Buildings", color: "#3b82f6", icon: "business" },
      { key: "tenants",   label: "Tenants",   color: "#8b5cf6", icon: "people" },
      { key: "stalls",    label: "Stalls",    color: "#ec4899", icon: "storefront" },
      { key: "meters",    label: "Meters",    color: "#06b6d4", icon: "speedometer" },
      { key: "readings",  label: "Readings",  color: "#10b981", icon: "document-text" },
    ];
    if (role === "admin") return base;
    if (role === "operator") return base.filter((t) => ["tenants", "stalls", "meters", "readings"].includes(t.key));
    if (role === "biller")   return base.filter((t) => ["tenants", "readings"].includes(t.key));
    return base;
  }, [role]);
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!token) {
        setBusy(false);
        return;
      }
      setBusy(true);
      const nextCounts: Counts = {};
      const nextRestr: Record<CountKey, boolean> = {
        buildings: false, tenants: false, stalls: false, meters: false, readings: false,
      };
      await Promise.all(
        wantedTiles.map(async (t) => {
          const { count, restricted } = await safeCount(api, `/${t.key}`);
          if (!alive) return;
          if (typeof count === "number") nextCounts[t.key] = count;
          if (restricted) nextRestr[t.key] = true;
        }),
      );
      if (!alive) return;
      setCounts(nextCounts);
      setRestrictions(nextRestr);
      setBusy(false);
    })();
    return () => { alive = false; };
  }, [token, role, wantedTiles.length]);
  const openPanel = (key: CountKey) => {
    router.push({ pathname: "/(tabs)/admin", params: { panel: key } } as any);
  };
  const isMobile = width < 768;
  const containerWidth = Platform.OS === "web" 
    ? Math.min(width - 48, 1400) 
    : width - 32;
  const getRoleDisplay = () => {
    const roleMap = { 
      admin: "Administrator", 
      operator: "Operator", 
      biller: "Biller", 
      unknown: "User" 
    };
    return roleMap[role] || "User";
  };
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good Morning";
    if (hour < 18) return "Good Afternoon";
    return "Good Evening";
  };
  const totalRecords = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scrollContainer}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
          <View style={[styles.header, { width: containerWidth }]}>
            <View style={styles.headerTop}>
              <View>
                <Text style={styles.greeting}>{getGreeting()}</Text>
                <Text style={styles.title}>JDN Meter & Billing</Text>
              </View>
              <View style={styles.roleBadge}>
                <View style={styles.roleIndicator} />
                <Text style={styles.roleText}>{getRoleDisplay()}</Text>
              </View>
            </View>
            <Text style={styles.subtitle}>
              Real-time metering analytics and billing automation platform
            </Text>
            <View style={[styles.statsRow, isMobile && styles.statsRowMobile]}>
              <View style={styles.statItem}>
                <Text style={styles.statValue}>{totalRecords}</Text>
                <Text style={styles.statLabel}>Total Records</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <View style={styles.statBadge}>
                  <View style={styles.liveDot} />
                  <Text style={styles.statBadgeText}>Live</Text>
                </View>
                <Text style={styles.statLabel}>System Status</Text>
              </View>
            </View>
            <View style={[styles.quickActions, isMobile && styles.quickActionsMobile]}>
              <QuickActionButton
                icon="scan-outline"
                label="Quick Scan"
                onPress={() => router.push("/(tabs)/scanner")}
                variant="primary"
              />
              <QuickActionButton
                icon="wallet-outline"
                label="Billing"
                onPress={() => router.push("/(tabs)/billing")}
              />
              <QuickActionButton
                icon="person-circle"
                label="Admin"
                onPress={() => openPanel(wantedTiles[0]?.key || "tenants")}
              />
            </View>
          </View>
          {busy ? (
            <View style={[styles.loadingContainer, { width: containerWidth }]}>
              <ActivityIndicator size="large" color="#3b82f6" />
              <Text style={styles.loadingText}>Loading dashboard...</Text>
            </View>
          ) : (
            <>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Overview</Text>
                <Text style={styles.sectionSubtitle}>
                  Monitor all operations in real-time
                </Text>
              </View>
              <View style={[styles.metricsGrid, { width: containerWidth }]}>
                {wantedTiles.map((tile) => {
                  const isRestricted = !!restrictions[tile.key];
                  const count = counts[tile.key] ?? 0;
                  return (
                    <MetricCard
                      key={tile.key}
                      tile={tile}
                      count={count}
                      isRestricted={isRestricted}
                      onPress={() => openPanel(tile.key)}
                    />
                  );
                })}
              </View>
            </>
          )}
          <View style={[styles.infoPanel, { width: containerWidth }]}>
            <View style={styles.infoPanelIcon}>
              <Ionicons name="information-circle" size={24} color="#3b82f6" />
            </View>
            <View style={styles.infoPanelContent}>
              <Text style={styles.infoPanelTitle}>Workflow Tip</Text>
              <Text style={styles.infoPanelText}>
                Use Scanner for offline readings, then batch-approve and generate invoices 
                from the Readings module for optimal efficiency.
              </Text>
            </View>
          </View>
          <View style={{ height: 40 }} />
        </Animated.View>
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#f8fafc",
  },
  scrollContainer: {
    flex: 1,
  },
  scrollContent: {
    paddingVertical: 24,
    paddingHorizontal: 16,
  },
  container: {
    alignSelf: "center",
    width: "100%",
    maxWidth: 1400,
    gap: 32,
  },
  header: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 32,
    gap: 24,
    alignSelf: "center",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 8,
      },
      android: {
        elevation: 2,
      },
      web: {
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
      } as any,
    }),
  },
  headerTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    flexWrap: "wrap",
    gap: 16,
  },
  greeting: {
    fontSize: 14,
    fontWeight: "500",
    color: "#64748b",
    marginBottom: 4,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#0f172a",
    letterSpacing: -0.5,
  },
  roleBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#f1f5f9",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  roleIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#3b82f6",
  },
  roleText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#475569",
  },
  subtitle: {
    fontSize: 15,
    color: "#64748b",
    lineHeight: 22,
  },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 24,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: "#f1f5f9",
  },
  statsRowMobile: {
    flexDirection: "column",
    alignItems: "flex-start",
  },
  statItem: {
    gap: 6,
  },
  statValue: {
    fontSize: 32,
    fontWeight: "700",
    color: "#0f172a",
    letterSpacing: -1,
  },
  statLabel: {
    fontSize: 13,
    fontWeight: "500",
    color: "#64748b",
  },
  statDivider: {
    width: 1,
    height: 40,
    backgroundColor: "#e2e8f0",
  },
  statBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#ecfdf5",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    alignSelf: "flex-start",
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#10b981",
  },
  statBadgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#059669",
  },
  quickActions: {
    flexDirection: "row",
    gap: 12,
  },
  quickActionsMobile: {
    flexDirection: "column",
  },
  actionButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#f8fafc",
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  actionButtonPrimary: {
    backgroundColor: "#3b82f6",
    borderColor: "#3b82f6",
  },
  actionIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
  },
  actionIconPrimary: {
    backgroundColor: "rgba(255, 255, 255, 0.2)",
  },
  actionLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    color: "#475569",
  },
  actionLabelPrimary: {
    color: "#ffffff",
  },
  sectionHeader: {
    gap: 4,
    marginTop: 8,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#0f172a",
  },
  sectionSubtitle: {
    fontSize: 14,
    color: "#64748b",
  },
  metricsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 24,
    alignSelf: "center",
  },
  metricCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 32,
    minWidth: 340,
    maxWidth: 420,
    flex: 1,
    gap: 24,
    borderWidth: 1,
    borderColor: "#f1f5f9",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 8,
      },
      android: {
        elevation: 2,
      },
      web: {
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
      } as any,
    }),
  },
  metricHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  iconContainer: {
    width: 56,
    height: 56,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#ecfdf5",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#059669",
  },
  metricBody: {
    gap: 4,
  },
  metricLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  metricValue: {
    fontSize: 42,
    fontWeight: "700",
    color: "#0f172a",
    letterSpacing: -1.5,
    marginVertical: 6,
  },
  metricSubtext: {
    fontSize: 14,
    color: "#94a3b8",
  },
  metricFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#f1f5f9",
  },
  viewDetailsText: {
    fontSize: 14,
    fontWeight: "600",
  },
  restrictedOverlay: {
    position: "absolute",
    top: 24,
    right: 24,
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "#f8fafc",
    alignItems: "center",
    justifyContent: "center",
  },
  loadingContainer: {
    alignSelf: "center",
    alignItems: "center",
    paddingVertical: 80,
    gap: 16,
  },
  loadingText: {
    fontSize: 15,
    color: "#64748b",
    fontWeight: "500",
  },
  infoPanel: {
    alignSelf: "center",
    backgroundColor: "#eff6ff",
    borderRadius: 12,
    padding: 20,
    flexDirection: "row",
    gap: 16,
    borderWidth: 1,
    borderColor: "#dbeafe",
  },
  infoPanelIcon: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
  },
  infoPanelContent: {
    flex: 1,
    gap: 4,
  },
  infoPanelTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#1e40af",
  },
  infoPanelText: {
    fontSize: 13,
    color: "#3b82f6",
    lineHeight: 20,
  },
});