import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Platform,
  TouchableOpacity,
  Image,
  ScrollView,
  Modal,
  Pressable,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAuth } from "../../contexts/AuthContext";

import AccountsPanel from "../../components/admin/AccountsPanel";
import BuildingPanel from "../../components/admin/BuildingPanel";
import WithholdingPanel from "../../components/admin/WithholdingPanel";
import VATPanel from "../../components/admin/VatPanel";
import StallsPanel from "../../components/admin/StallsPanel";
import TenantsPanel from "../../components/admin/TenantsPanel";
import AssignTenantPanel from "../../components/admin/AssignTenantPanel";
import MeterPanel from "../../components/admin/MeterPanel";
import MeterReadingPanel from "../../components/admin/MeterReadingPanel";
import ReaderDevicesPanel from "../../components/admin/ReaderDevicesPanel";
import OfflineSubmissionsPanel from "../../components/admin/OfflineSubmissionsPanel";

export type PageKey =
  | "accounts"
  | "buildings"
  | "stalls"
  | "wt"
  | "vat"
  | "tenants"
  | "assign"
  | "meters"
  | "readings"
  | "readerDevices"
  | "offlineSubmissions";

type Page = {
  label: string;
  key: PageKey;
  icon: keyof typeof Ionicons.glyphMap;
};

const MOBILE_BREAKPOINT = 768;

export default function AdminScreen() {
  const router = useRouter();
  const { token, user, logout } = useAuth();
  const params = useLocalSearchParams<{
    panel?: string;
    tab?: string;
    meterId?: string;
  }>();
  const { width } = useWindowDimensions();
  const isMobile = width < MOBILE_BREAKPOINT;

  const [menuOpen, setMenuOpen] = useState(false);

  const pages: Page[] = useMemo(
    () => [
      { label: "Accounts", key: "accounts", icon: "people" },
      { label: "Buildings", key: "buildings", icon: "business" },
      { label: "Stalls", key: "stalls", icon: "storefront" },
      { label: "Withholding", key: "wt", icon: "receipt" },
      { label: "VAT", key: "vat", icon: "calculator" },
      { label: "Tenants", key: "tenants", icon: "person" },
      { label: "Assign", key: "assign", icon: "person-add" },
      { label: "Meters", key: "meters", icon: "speedometer" },
      { label: "Readings", key: "readings", icon: "analytics" },

      { label: "Reader Devices", key: "readerDevices", icon: "phone-portrait" },

      { label: "Offline Submissions", key: "offlineSubmissions", icon: "cloud-upload" },
    ],
    []
  );

  const role: string = useMemo(() => {
    const rawRoles: any = user?.user_roles;
    const roles: string[] = Array.isArray(rawRoles)
      ? rawRoles
      : typeof rawRoles === "string"
      ? rawRoles.split(",").map((r) => r.trim())
      : [];

    if (roles.includes("admin")) return "admin";
    if (roles.includes("operator")) return "operator";
    if (roles.includes("biller")) return "biller";
    if (roles.includes("reader")) return "reader";
    return "admin";
  }, [user]);

  const roleAllowed: Record<string, Set<PageKey>> = useMemo(
    () => ({
      admin: new Set<PageKey>([
        "accounts",
        "buildings",
        "stalls",
        "wt",
        "vat",
        "tenants",
        "assign",
        "meters",
        "readings",
        "readerDevices",
        "offlineSubmissions",
      ]),
      operator: new Set<PageKey>(["stalls", "tenants", "meters", "readings"]),
      biller: new Set<PageKey>(["buildings", "wt", "vat", "tenants", "readings"]),
      reader: new Set<PageKey>(["readings"]),
    }),
    []
  );

  const allowed = roleAllowed[role] ?? roleAllowed.admin;
  const visiblePages = useMemo(() => pages.filter((p) => allowed.has(p.key)), [pages, allowed]);

  const roleInitial: Record<string, PageKey> = {
    admin: "buildings",
    operator: "stalls",
    biller: "buildings",
    reader: "readings",
  };

  const resolveInitial = (): PageKey => {
    const wanted = String(params?.panel || params?.tab || "").toLowerCase() as PageKey;
    if (wanted && allowed.has(wanted)) return wanted;
    return roleInitial[role] ?? "buildings";
  };

  const [active, setActive] = useState<PageKey>(resolveInitial());

  useEffect(() => {
    const wanted = String(params?.panel || params?.tab || "").toLowerCase() as PageKey;
    const allowedSet = roleAllowed[role] ?? roleAllowed.admin;

    if (wanted && allowedSet.has(wanted)) {
      setActive(wanted);
    } else if (!allowedSet.has(active)) {
      setActive(roleInitial[role] ?? "buildings");
    }
  }, [role, params?.panel, params?.tab, allowed, active, roleAllowed]);

  const applyRouteParam = (key: PageKey) => {
    try {
      router.setParams?.({ panel: key });
    } catch {
    }
  };

  const handleSelect = (key: PageKey) => {
    setActive(key);
    applyRouteParam(key);
    setMenuOpen(false);
  };

  const handleLogout = async () => {
    setMenuOpen(false);
    await logout();
    router.replace?.("/(auth)/login");
  };

  const renderContent = () => {
    switch (active) {
      case "accounts":
        return <AccountsPanel token={token} />;
      case "buildings":
        return <BuildingPanel token={token} />;
      case "stalls":
        return <StallsPanel token={token} />;
      case "wt":
        return <WithholdingPanel token={token} />;
      case "vat":
        return <VATPanel token={token} />;
      case "tenants":
        return <TenantsPanel token={token} />;
      case "assign":
        return <AssignTenantPanel token={token} />;
      case "meters":
        return <MeterPanel token={token} />;
      case "readings":
        return (
          <MeterReadingPanel
            token={token}
            initialMeterId={params?.meterId ? String(params.meterId) : undefined}
          />
        );
      case "readerDevices":
        return <ReaderDevicesPanel />;

      case "offlineSubmissions":
        return <OfflineSubmissionsPanel />;

      default:
        return null;
    }
  };

  const displayName = user?.user_fullname ?? "";
  const initials = displayName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const roleColors: Record<string, { bg: string; text: string }> = {
    admin: { bg: "rgba(99, 102, 241, 0.1)", text: "#6366f1" },
    operator: { bg: "rgba(16, 185, 129, 0.1)", text: "#10b981" },
    biller: { bg: "rgba(245, 158, 11, 0.1)", text: "#f59e0b" },
    reader: { bg: "rgba(59, 130, 246, 0.1)", text: "#3b82f6" },
  };

  const currentRoleStyle = roleColors[role] || roleColors.admin;
  const activePageLabel = visiblePages.find((p) => p.key === active)?.label || "Admin";

  const MobileMenu = () => (
    <Modal
      visible={menuOpen}
      animationType="fade"
      transparent
      onRequestClose={() => setMenuOpen(false)}
    >
      <View style={styles.modalOverlay}>
        <Pressable style={styles.modalBackdrop} onPress={() => setMenuOpen(false)} />
        <View style={styles.drawer}>
          <View style={styles.drawerHeader}>
            <View style={styles.drawerLogoRow}>
              <View style={styles.logoWrap}>
                <Image source={require("../../assets/images/jdn.jpg")} style={styles.logo} />
              </View>
              <View>
                <Text style={styles.drawerTitle}>Admin Portal</Text>
                <Text style={styles.drawerSub}>Management Console</Text>
              </View>
            </View>
            <TouchableOpacity onPress={() => setMenuOpen(false)} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color="#64748b" />
            </TouchableOpacity>
          </View>

          <View style={styles.drawerUser}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials || "U"}</Text>
            </View>
            <View style={styles.drawerUserInfo}>
              <Text style={styles.drawerUserName}>{displayName || "User"}</Text>
              <View style={[styles.roleBadge, { backgroundColor: currentRoleStyle.bg }]}>
                <Text style={[styles.roleText, { color: currentRoleStyle.text }]}>
                  {role.charAt(0).toUpperCase() + role.slice(1)}
                </Text>
              </View>
            </View>
          </View>

          <ScrollView style={styles.drawerNav} showsVerticalScrollIndicator={false}>
            <Text style={styles.drawerLabel}>NAVIGATION</Text>
            {visiblePages.map((page) => {
              const isActive = active === page.key;
              return (
                <TouchableOpacity
                  key={page.key}
                  onPress={() => handleSelect(page.key)}
                  style={[styles.drawerItem, isActive && styles.drawerItemActive]}
                  activeOpacity={0.7}
                >
                  <View style={[styles.drawerIconWrap, isActive && styles.drawerIconWrapActive]}>
                    <Ionicons
                      name={(isActive ? page.icon : (`${page.icon}-outline` as any)) as any}
                      size={18}
                      color={isActive ? "#fff" : "#64748b"}
                    />
                  </View>
                  <Text style={[styles.drawerItemText, isActive && styles.drawerItemTextActive]}>
                    {page.label}
                  </Text>
                  {isActive && <Ionicons name="checkmark-circle" size={18} color="#6366f1" />}
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={styles.drawerFooter}>
            <TouchableOpacity onPress={handleLogout} style={styles.drawerLogout} activeOpacity={0.7}>
              <Ionicons name="log-out-outline" size={20} color="#ef4444" />
              <Text style={styles.drawerLogoutText}>Logout</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );

  return (
    <SafeAreaView style={styles.screen}>
      {isMobile && <MobileMenu />}

      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {isMobile ? (
            <>
              <TouchableOpacity onPress={() => setMenuOpen(true)} style={styles.hamburger}>
                <Ionicons name="menu" size={24} color="#0f172a" />
              </TouchableOpacity>
              <Text style={styles.mobileTitle}>{activePageLabel}</Text>
            </>
          ) : (
            <>
              <View style={styles.logoWrap}>
                <Image source={require("../../assets/images/jdn.jpg")} style={styles.logo} />
              </View>
              <View style={styles.titleWrap}>
                <Text style={styles.brandTitle}>Admin Portal</Text>
                <Text style={styles.brandSub}>Management Console</Text>
              </View>
            </>
          )}
        </View>

        {!isMobile && (
          <View style={styles.headerRight}>
            <View style={styles.userCard}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initials || "U"}</Text>
              </View>
              <View style={styles.userInfo}>
                <Text style={styles.userName} numberOfLines={1}>
                  {displayName || "User"}
                </Text>
                <View style={[styles.roleBadge, { backgroundColor: currentRoleStyle.bg }]}>
                  <Text style={[styles.roleText, { color: currentRoleStyle.text }]}>
                    {role.charAt(0).toUpperCase() + role.slice(1)}
                  </Text>
                </View>
              </View>
            </View>
            <View style={styles.headerDivider} />
            <TouchableOpacity onPress={handleLogout} style={styles.logoutBtn} activeOpacity={0.7}>
              <Ionicons name="log-out-outline" size={18} color="#64748b" />
              <Text style={styles.logoutText}>Logout</Text>
            </TouchableOpacity>
          </View>
        )}

        {isMobile && (
          <View style={styles.mobileHeaderRight}>
            <View style={styles.avatarSmall}>
              <Text style={styles.avatarTextSmall}>{initials || "U"}</Text>
            </View>
          </View>
        )}
      </View>

      {!isMobile && (
        <View style={styles.tabBar}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.tabScroll}
          >
            {visiblePages.map((page) => {
              const isActive = active === page.key;
              return (
                <TouchableOpacity
                  key={page.key}
                  onPress={() => handleSelect(page.key)}
                  style={[styles.tab, isActive && styles.tabActive]}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={(isActive ? page.icon : (`${page.icon}-outline` as any)) as any}
                    size={16}
                    color={isActive ? "#6366f1" : "#64748b"}
                  />
                  <Text style={[styles.tabText, isActive && styles.tabTextActive]}>
                    {page.label}
                  </Text>
                  {isActive && <View style={styles.tabIndicator} />}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      <View style={[styles.content, isMobile && styles.contentMobile]}>{renderContent()}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#f8fafc",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#ffffff",
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
    ...(Platform.OS === "web"
      ? {
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }
      : {
          shadowColor: "#000",
          shadowOpacity: 0.04,
          shadowRadius: 3,
          shadowOffset: { width: 0, height: 1 },
        }),
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  hamburger: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: "#f1f5f9",
    alignItems: "center",
    justifyContent: "center",
  },
  mobileTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#0f172a",
  },
  logoWrap: {
    width: 42,
    height: 42,
    borderRadius: 10,
    overflow: "hidden",
    ...(Platform.OS === "web"
      ? {
          boxShadow: "0 2px 6px rgba(0,0,0,0.08)",
        }
      : {
          shadowColor: "#000",
          shadowOpacity: 0.08,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 2 },
        }),
  },
  logo: {
    width: 42,
    height: 42,
  },
  titleWrap: {
    gap: 1,
  },
  brandTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#0f172a",
    letterSpacing: -0.3,
  },
  brandSub: {
    fontSize: 12,
    color: "#94a3b8",
    fontWeight: "500",
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  mobileHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
  },
  userCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: "#6366f1",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#fff",
  },
  avatarSmall: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "#6366f1",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarTextSmall: {
    fontSize: 12,
    fontWeight: "700",
    color: "#fff",
  },
  userInfo: {
    gap: 2,
  },
  userName: {
    fontSize: 13,
    fontWeight: "600",
    color: "#0f172a",
    maxWidth: 120,
  },
  roleBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  roleText: {
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  headerDivider: {
    width: 1,
    height: 28,
    backgroundColor: "#e2e8f0",
  },
  logoutBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  logoutText: {
    fontSize: 13,
    fontWeight: "500",
    color: "#64748b",
  },
  tabBar: {
    backgroundColor: "#ffffff",
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  tabScroll: {
    paddingHorizontal: 16,
    gap: 4,
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    position: "relative",
  },
  tabActive: {},
  tabText: {
    fontSize: 13,
    fontWeight: "500",
    color: "#64748b",
  },
  tabTextActive: {
    color: "#6366f1",
    fontWeight: "600",
  },
  tabIndicator: {
    position: "absolute",
    bottom: 0,
    left: 14,
    right: 14,
    height: 2,
    backgroundColor: "#6366f1",
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
  },
  content: {
    flex: 1,
    padding: 20,
  },
  contentMobile: {
    padding: 12,
  },
  modalOverlay: {
    flex: 1,
    flexDirection: "row",
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(15, 23, 42, 0.4)",
  },
  drawer: {
    width: 300,
    maxWidth: "85%",
    backgroundColor: "#ffffff",
    height: "100%",
    ...(Platform.OS === "web"
      ? {
          boxShadow: "4px 0 24px rgba(0,0,0,0.12)",
        }
      : {
          shadowColor: "#000",
          shadowOpacity: 0.12,
          shadowRadius: 24,
          shadowOffset: { width: 4, height: 0 },
        }),
  },
  drawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  drawerLogoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  drawerTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#0f172a",
  },
  drawerSub: {
    fontSize: 11,
    color: "#94a3b8",
    fontWeight: "500",
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: "#f8fafc",
    alignItems: "center",
    justifyContent: "center",
  },
  drawerUser: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    backgroundColor: "#f8fafc",
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
  },
  drawerUserInfo: {
    flex: 1,
    gap: 4,
  },
  drawerUserName: {
    fontSize: 14,
    fontWeight: "600",
    color: "#0f172a",
  },
  drawerNav: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  drawerLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#94a3b8",
    letterSpacing: 0.5,
    marginBottom: 12,
    marginLeft: 4,
  },
  drawerItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 10,
    marginBottom: 4,
  },
  drawerItemActive: {
    backgroundColor: "#f1f5f9",
  },
  drawerIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: "#f8fafc",
    alignItems: "center",
    justifyContent: "center",
  },
  drawerIconWrapActive: {
    backgroundColor: "#6366f1",
  },
  drawerItemText: {
    flex: 1,
    fontSize: 14,
    fontWeight: "500",
    color: "#64748b",
  },
  drawerItemTextActive: {
    color: "#0f172a",
    fontWeight: "600",
  },
  drawerFooter: {
    paddingHorizontal: 16,
    paddingVertical: 20,
    borderTopWidth: 1,
    borderTopColor: "#f1f5f9",
  },
  drawerLogout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "rgba(239, 68, 68, 0.08)",
  },
  drawerLogoutText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#ef4444",
  },
});