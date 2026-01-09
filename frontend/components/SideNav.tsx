import React, { useMemo, useRef, useState, useEffect } from "react";
import {
  View,
  TouchableOpacity,
  StyleSheet,
  Image,
  Text,
  Platform,
  Animated,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../contexts/AuthContext";

export type TabKey = "dashboard" | "admin" | "scanner" | "billing" | "logout";

type Props = {
  active: TabKey;
  onSelect: (tab: TabKey) => void;
};

function decodeRole(token: string | null): string {
  try {
    if (!token) return "";
    const p = token.split(".")[1];
    const base64 = p.replace(/-/g, "+").replace(/_/g, "/");
    const json =
      typeof (globalThis as any).atob === "function"
        ? (globalThis as any).atob(base64)
        : "";
    return json ? String(JSON.parse(json)?.user_level || "").toLowerCase() : "";
  } catch {
    return "";
  }
}

export default function SideNav({ active, onSelect }: Props) {
  const { token, hasRole } = useAuth();
  const legacyRole = useMemo(() => decodeRole(token), [token]);

  const isAdmin = hasRole("admin") || legacyRole === "admin";
  const isOperator = hasRole("operator") || legacyRole === "operator";
  const isBiller = hasRole("biller") || legacyRole === "biller";
  const isReader = hasRole("reader") || legacyRole === "reader";

  const nonAdminRoles = [
    isOperator ? "operator" : null,
    isBiller ? "biller" : null,
    isReader ? "reader" : null,
  ].filter(Boolean) as string[];

  const isPureOperator = !isAdmin && nonAdminRoles.length === 1 && nonAdminRoles[0] === "operator";
  const isPureBiller = !isAdmin && nonAdminRoles.length === 1 && nonAdminRoles[0] === "biller";
  const isPureReader = !isAdmin && nonAdminRoles.length === 1 && nonAdminRoles[0] === "reader";

  const canSeeAdmin = isAdmin || isOperator || isBiller || isReader;
  const canSeeScanner = isAdmin || isPureReader;
  const canSeeBilling = isAdmin || isPureBiller;
  const canSeeDashboard = isAdmin || isOperator || isBiller || isReader;

  const homeTab: TabKey =
    isPureBiller && canSeeBilling
      ? "billing"
      : canSeeAdmin
      ? "admin"
      : canSeeBilling
      ? "billing"
      : canSeeScanner
      ? "scanner"
      : "dashboard";

  const [expanded, setExpanded] = useState(false);
  const widthAnim = useRef(new Animated.Value(72)).current;

  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: expanded ? 240 : 72,
      duration: 220,
      useNativeDriver: false,
    }).start();
  }, [expanded, widthAnim]);

  const NavItem = ({
    icon,
    label,
    tab,
  }: {
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    tab: TabKey;
  }) => {
    const isActive = active === tab;
    return (
      <TouchableOpacity
        onPress={() => onSelect(tab)}
        style={[styles.item, isActive && styles.itemActive]}
        activeOpacity={0.7}
        {...(Platform.OS === "web" && !expanded ? { title: label } : {})}
      >
        <View style={[styles.itemInner, expanded && styles.itemInnerExpanded]}>
          <View style={[styles.iconWrap, isActive && styles.iconWrapActive]}>
            <Ionicons
              name={icon}
              size={20}
              color={isActive ? "#fff" : "rgba(255,255,255,0.7)"}
            />
          </View>
          {expanded && (
            <Text style={[styles.itemLabel, isActive && styles.itemLabelActive]}>
              {label}
            </Text>
          )}
        </View>
        {isActive && <View style={styles.activeIndicator} />}
      </TouchableOpacity>
    );
  };

  return (
    <Animated.View style={[styles.container, { width: widthAnim }]}>
      {/* Logo */}
      <TouchableOpacity
        style={[styles.logoContainer, expanded && styles.logoContainerExpanded]}
        onPress={() => onSelect(homeTab)}
        activeOpacity={0.8}
        {...(Platform.OS === "web" && !expanded ? { title: "Home" } : {})}
      >
        <View style={styles.logoWrap}>
          <Image
            source={require("../assets/images/jdn.jpg")}
            style={styles.logo}
          />
        </View>
        {expanded && (
          <View style={styles.brandInfo}>
            <Text style={styles.brandName}>JDN</Text>
            <Text style={styles.brandSub}>Portal</Text>
          </View>
        )}
      </TouchableOpacity>

      {/* Divider */}
      <View style={styles.divider} />

      {/* Navigation */}
      <View style={styles.navSection}>
        {canSeeAdmin && <NavItem icon="people-outline" label="Admin" tab="admin" />}
        {canSeeScanner && <NavItem icon="scan-outline" label="Scanner" tab="scanner" />}
        {canSeeBilling && <NavItem icon="wallet-outline" label="Billing" tab="billing" />}
      </View>

      <View style={styles.spacer} />

      {/* Bottom section */}
      <View style={styles.bottomSection}>
        {canSeeDashboard && (
          <NavItem icon="analytics-outline" label="Dashboard" tab="dashboard" />
        )}

        <View style={styles.dividerThin} />

        {/* Expand/Collapse */}
        <TouchableOpacity
          onPress={() => setExpanded((v) => !v)}
          style={styles.toggleBtn}
          activeOpacity={0.7}
          accessibilityLabel={expanded ? "Collapse sidebar" : "Expand sidebar"}
          {...(Platform.OS === "web" ? { title: expanded ? "Collapse" : "Expand" } : {})}
        >
          <View style={[styles.itemInner, expanded && styles.itemInnerExpanded]}>
            <View style={styles.toggleIconWrap}>
              <Ionicons
                name={expanded ? "chevron-back" : "chevron-forward"}
                size={18}
                color="rgba(255,255,255,0.6)"
              />
            </View>
            {expanded && <Text style={styles.toggleLabel}>Collapse</Text>}
          </View>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: "100%",
    paddingVertical: 20,
    paddingHorizontal: 12,
    backgroundColor: "#082cac",
    overflow: "hidden",
    ...(Platform.OS === "web"
      ? {
          background: "linear-gradient(180deg, #0a3ad1 0%, #082cac 100%)",
          boxShadow: "4px 0 24px rgba(8,44,172,0.3)",
        }
      : {
          shadowColor: "#082cac",
          shadowOpacity: 0.3,
          shadowRadius: 24,
          shadowOffset: { width: 4, height: 0 },
        }),
  },

  // Logo
  logoContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 4,
    marginBottom: 8,
  },
  logoContainerExpanded: {
    flexDirection: "row",
    justifyContent: "flex-start",
    paddingHorizontal: 4,
    gap: 12,
  },
  logoWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
    ...(Platform.OS === "web"
      ? { boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }
      : { elevation: 4 }),
  },
  logo: {
    width: 44,
    height: 44,
    borderRadius: 12,
  },
  brandInfo: {
    justifyContent: "center",
  },
  brandName: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  brandSub: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 11,
    fontWeight: "500",
    letterSpacing: 0.3,
    marginTop: 1,
  },

  // Dividers
  divider: {
    height: 1,
    backgroundColor: "rgba(255,255,255,0.08)",
    marginVertical: 16,
    marginHorizontal: 4,
  },
  dividerThin: {
    height: 1,
    backgroundColor: "rgba(255,255,255,0.06)",
    marginVertical: 12,
    marginHorizontal: 8,
  },

  // Navigation
  navSection: {
    gap: 4,
  },
  spacer: {
    flex: 1,
  },
  bottomSection: {
    gap: 4,
  },

  // Nav Item
  item: {
    position: "relative",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 8,
    ...(Platform.OS === "web"
      ? {
          cursor: "pointer",
          transition: "background 150ms ease",
        }
      : {}),
  },
  itemActive: {
    backgroundColor: "rgba(255, 255, 255, 0.12)",
  },
  itemInner: {
    alignItems: "center",
    justifyContent: "center",
  },
  itemInnerExpanded: {
    flexDirection: "row",
    justifyContent: "flex-start",
    gap: 12,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  iconWrapActive: {
    backgroundColor: "rgba(255,255,255,0.25)",
    ...(Platform.OS === "web"
      ? { boxShadow: "0 4px 12px rgba(0, 0, 0, 0.2)" }
      : {}),
  },
  itemLabel: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 14,
    fontWeight: "500",
    letterSpacing: 0.2,
  },
  itemLabelActive: {
    color: "#fff",
    fontWeight: "600",
  },
  activeIndicator: {
    position: "absolute",
    left: 0,
    top: "50%",
    marginTop: -10,
    width: 3,
    height: 20,
    borderRadius: 2,
    backgroundColor: "#fff",
  },

  // Toggle
  toggleBtn: {
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 8,
    ...(Platform.OS === "web"
      ? {
          cursor: "pointer",
          transition: "background 150ms ease",
        }
      : {}),
  },
  toggleIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  toggleLabel: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 13,
    fontWeight: "500",
  },
});