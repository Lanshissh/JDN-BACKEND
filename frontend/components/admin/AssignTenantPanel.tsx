import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  KeyboardAvoidingView,
  ScrollView,
  Dimensions,
  useWindowDimensions,
} from "react-native";
import axios from "axios";
import { Picker } from "@react-native-picker/picker";
import { Ionicons } from "@expo/vector-icons";
import { BASE_API } from "../../constants/api";
type Building = { building_id: string; building_name: string };
type Tenant = {
  tenant_id: string;
  tenant_name: string;
  building_id: string;
  tenant_status: "active" | "inactive" | string;
};
type Stall = {
  stall_id: string;
  stall_sn: string;
  building_id: string;
  tenant_id: string | null;
  stall_status: "available" | "occupied" | "under maintenance" | string;
  last_updated?: string;
  updated_by?: string;
};
function notify(title: string, message?: string) {
  if (Platform.OS === "web" && typeof window !== "undefined" && window.alert) {
    window.alert(message ? `${title}\n\n${message}` : title);
  } else {
    Alert.alert(title, message);
  }
}
function errorText(err: any, fallback = "Server error.") {
  const d = err?.response?.data;
  if (typeof d === "string") return d;
  if (d?.error) return String(d.error);
  if (d?.message) return String(d.message);
  if (err?.message) return String(err.message);
  try { return JSON.stringify(d ?? err); } catch { return fallback; }
}
const cmp = (a: string | number, b: string | number) =>
  String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true, sensitivity: "base" });
export default function AssignTenantPanel({ token }: { token: string | null }) {
  const { width } = useWindowDimensions();
  const isMobile = width < 640;
  const authHeader = useMemo(() => ({ Authorization: `Bearer ${token ?? ""}` }), [token]);
  const api = useMemo(() => axios.create({ baseURL: BASE_API, headers: authHeader, timeout: 15000 }), [authHeader]);
  const [busy, setBusy] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [stalls, setStalls] = useState<Stall[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [buildingId, setBuildingId] = useState<string>(""); 
  const [buildingPickerVisible, setBuildingPickerVisible] = useState(false); 
  const [search, setSearch] = useState("");
  const [assignVisible, setAssignVisible] = useState(false);
  const [assignStall, setAssignStall] = useState<Stall | null>(null);
  const [assignTenantId, setAssignTenantId] = useState("");
  useEffect(() => {
    (async () => {
      if (!token) { setBusy(false); notify("Not logged in", "Please log in to assign tenants."); return; }
      try {
        setBusy(true);
        const [bRes, sRes, tRes] = await Promise.all([
          api.get<Building[]>("/buildings").catch(() => ({ data: [] as Building[] })), 
          api.get<Stall[]>("/stalls"),
          api.get<Tenant[]>("/tenants"),
        ]);
        const b = bRes.data || []; const s = sRes.data || []; const t = tRes.data || [];
        setBuildings(b); setStalls(s); setTenants(t);
        if (!buildingId && b.length) setBuildingId(String(b[0].building_id));
      } catch (err) {
        notify("Load failed", errorText(err, "Connection error."));
      } finally { setBusy(false); }
    })();
  }, [token]); 
  const visibleStalls = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = (stalls || []).filter((s) => s.stall_status === "available");
    if (buildingId) list = list.filter((s) => s.building_id === buildingId);
    if (q) list = list.filter(
      (s) =>
        (s.stall_sn || "").toLowerCase().includes(q) ||
        s.stall_id.toLowerCase().includes(q)
    );
    return [...list].sort((a, b) => cmp(a.stall_sn, b.stall_sn));
  }, [stalls, buildingId, search]);
  const activeTenants = useMemo(() => {
    let list = (tenants || []).filter((t) => (t.tenant_status || "").toLowerCase() === "active");
    if (buildingId) list = list.filter((t) => t.building_id === buildingId);
    return [...list].sort((a, b) => cmp(a.tenant_name, b.tenant_name));
  }, [tenants, buildingId]);
  function openAssignModal(stall: Stall) {
    setAssignStall(stall);
    setAssignTenantId("");
    setAssignVisible(true);
  }
  const onAssign = async () => {
    if (!assignStall || !assignTenantId) { notify("Missing info", "Please select a tenant."); return; }
    try {
      setSubmitting(true);
      await api.put(`/stalls/${encodeURIComponent(assignStall.stall_id)}`, {
        stall_sn: assignStall.stall_sn,
        building_id: assignStall.building_id,
        stall_status: "occupied",
        tenant_id: assignTenantId,
      });
      setAssignVisible(false);
      setAssignStall(null);
      setAssignTenantId("");
      setBusy(true);
      const sRes = await api.get<Stall[]>("/stalls");
      setStalls(sRes.data || []);
      setBusy(false);
      notify("Success", "Tenant assigned to stall.");
    } catch (err) {
      notify("Assign failed", errorText(err));
    } finally { setSubmitting(false); }
  };
  const Chip = ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) => (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.chip, active ? styles.chipActive : styles.chipIdle]}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
    >
      <Text style={[styles.chipText, active ? styles.chipTextActive : styles.chipTextIdle]}>{label}</Text>
    </TouchableOpacity>
  );
  const Header = () => (
    <View style={styles.headerRow}>
      <Text style={styles.title}>Assign Tenant</Text>
      <Text style={styles.subtitle}>Pick an available stall and link it to an active tenant in the same building.</Text>
    </View>
  );
  const Toolbar = () => (
    <>
      <View style={styles.filtersBar}>
        <View style={[styles.searchWrap, { flex: 1 }]}>
          <Ionicons name="search-outline" size={16} color="#94a3b8" style={{ marginRight: 6 }} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search stall SN or ID…"
            placeholderTextColor="#9aa5b1"
            style={styles.search}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>
      </View>
      <View style={{ marginTop: 6, marginBottom: 10 }}>
        <View style={styles.buildingHeaderRow}>
          <Text style={styles.label}>Building</Text>
        </View>
        {isMobile ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipsRowHorizontal}
          >
            <Chip label="All" active={!buildingId} onPress={() => setBuildingId("")} />
            {buildings
              .slice()
              .sort((a, b) => a.building_name.localeCompare(b.building_name))
              .map((b) => (
                <Chip
                  key={b.building_id}
                  label={b.building_name || b.building_id}
                  active={buildingId === b.building_id}
                  onPress={() => setBuildingId(b.building_id)}
                />
              ))}
          </ScrollView>
        ) : (
          <View style={styles.chipsRow}>
            <Chip label="All" active={!buildingId} onPress={() => setBuildingId("")} />
            {buildings
              .slice()
              .sort((a, b) => a.building_name.localeCompare(b.building_name))
              .map((b) => (
                <Chip
                  key={b.building_id}
                  label={b.building_name || b.building_id}
                  active={buildingId === b.building_id}
                  onPress={() => setBuildingId(b.building_id)}
                />
              ))}
          </View>
        )}
      </View>
    </>
  );
  const Row = ({ item }: { item: Stall }) => (
    <View style={[styles.rowCard, isMobile && styles.rowCardMobile]}>
      <View style={{ flex: 1, paddingRight: 6 }}>
        <Text style={styles.rowTitle}>{item.stall_sn || "—"}</Text>
        <Text style={styles.rowSub}>ID: {item.stall_id} · Building {item.building_id}</Text>
      </View>
      {isMobile ? (
        <View style={styles.rowActionsMobile}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.primaryBtn]}
            onPress={() => openAssignModal(item)}
            accessibilityLabel={`Assign ${item.stall_sn}`}
          >
            <Ionicons name="person-add-outline" size={16} color="#fff" />
            <Text style={[styles.actionText, styles.actionTextPrimary]}>Assign</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.rowActions}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.primaryBtn]}
            onPress={() => openAssignModal(item)}
            accessibilityLabel={`Assign ${item.stall_sn}`}
          >
            <Ionicons name="person-add-outline" size={16} color="#fff" />
            <Text style={[styles.actionText, styles.actionTextPrimary]}>Assign</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <Header />
        <Toolbar />
        {busy ? (
          <View style={styles.loader}>
            <ActivityIndicator />
            <Text style={styles.loadingText}>Loading available stalls…</Text>
          </View>
        ) : visibleStalls.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Ionicons name="archive-outline" size={26} color="#94a3b8" />
            <Text style={styles.emptyTitle}>No available stalls</Text>
            <Text style={styles.emptyHint}>Try another building or clear the search.</Text>
          </View>
        ) : (
          <FlatList
            data={visibleStalls}
            keyExtractor={(it) => String(it.stall_id)}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 12 }}
            renderItem={Row}
          />
        )}
      </View>
      <Modal visible={buildingPickerVisible} transparent animationType="fade" onRequestClose={() => setBuildingPickerVisible(false)}>
        <View style={styles.overlay}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ width: "100%" }}>
            <View
              style={[
                styles.modalCard,
                Platform.OS !== "web" && { maxHeight: Math.round(Dimensions.get("window").height * 0.9) },
              ]}
            >
              <View style={styles.modalHeaderRow}>
                <Text style={styles.modalTitle}>Select Building</Text>
                <TouchableOpacity onPress={() => setBuildingPickerVisible(false)}>
                  <Ionicons name="close" size={20} color="#64748b" />
                </TouchableOpacity>
              </View>
              <View style={styles.modalDivider} />
              <View style={styles.select}>
                <Picker
                  selectedValue={buildingId}
                  onValueChange={(v) => setBuildingId(String(v))}
                  mode={Platform.OS === "android" ? "dropdown" : undefined}
                >
                  <Picker.Item label="All" value="" />
                  {buildings.map((b) => (
                    <Picker.Item key={b.building_id} label={`${b.building_name} (${b.building_id})`} value={b.building_id} />
                  ))}
                </Picker>
              </View>
              <View style={styles.modalActions}>
                <TouchableOpacity style={[styles.smallBtn, styles.ghostBtn]} onPress={() => setBuildingPickerVisible(false)}>
                  <Text style={[styles.smallBtnText, styles.ghostBtnText]}>Done</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
      <Modal visible={assignVisible} transparent animationType="fade" onRequestClose={() => setAssignVisible(false)}>
        <View style={styles.overlay}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ width: "100%" }}>
            <View
              style={[
                styles.modalCard,
                Platform.OS !== "web" && { maxHeight: Math.round(Dimensions.get("window").height * 0.9) },
              ]}
            >
              <View style={styles.modalHeaderRow}>
                <Text style={styles.modalTitle}>Assign Tenant to Stall</Text>
                <TouchableOpacity onPress={() => setAssignVisible(false)}>
                  <Ionicons name="close" size={20} color="#64748b" />
                </TouchableOpacity>
              </View>
              <View style={styles.modalDivider} />
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 12, gap: 10 }}>
                <View style={styles.summaryBox}>
                  <Ionicons name="information-circle-outline" size={18} color="#2563eb" />
                  <Text style={styles.summaryText}>
                    {assignStall ? `${assignStall.stall_sn} • ID ${assignStall.stall_id} • Building ${assignStall.building_id}` : "—"}
                  </Text>
                </View>
                <View>
                  <Text style={styles.label}>Tenant</Text>
                  <View style={[styles.select, styles.selectEmphasis]}>
                    <Picker selectedValue={assignTenantId} onValueChange={setAssignTenantId} mode="dropdown">
                      <Picker.Item label="Select tenant…" value="" />
                      {activeTenants.map((t) => (
                        <Picker.Item key={t.tenant_id} label={`${t.tenant_name} (${t.tenant_id})`} value={t.tenant_id} />
                      ))}
                    </Picker>
                  </View>
                  {activeTenants.length === 0 ? (
                    <Text style={styles.helpText}>No active tenants{buildingId ? " for this building" : ""}.</Text>
                  ) : null}
                </View>
              </ScrollView>
              <View style={styles.modalActions}>
                <TouchableOpacity style={[styles.smallBtn, styles.ghostBtn]} onPress={() => setAssignVisible(false)} disabled={submitting}>
                  <Text style={[styles.smallBtnText, styles.ghostBtnText]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.smallBtn, styles.primaryBtn, submitting && styles.btnDisabled]}
                  onPress={onAssign}
                  disabled={submitting}
                >
                  {submitting ? <ActivityIndicator color="#fff" /> : <>
                    <Ionicons name="checkmark-circle-outline" size={16} color="#fff" />
                    <Text style={styles.smallBtnText}>Assign</Text>
                  </>}
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </View>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, minHeight: 0, padding: 12, backgroundColor: "#f8fafc" },
  card: {
    flex: 1,
    minHeight: 0,
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: "#eef2f7",
    ...(Platform.select({
      web: { boxShadow: "0 10px 30px rgba(2,6,23,0.06)" as any },
      default: { elevation: 3 },
    }) as any),
  },
  headerRow: { gap: 4, marginBottom: 6 },
  title: { fontSize: 18, fontWeight: "900", color: "#0f172a" },
  subtitle: { fontSize: 12, color: "#475569" },
  filtersBar: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6, marginBottom: 6, flexWrap: "wrap" },
  searchWrap: {
    minHeight: 40,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
  },
  search: { flex: 1, color: "#0f172a", paddingVertical: Platform.OS === "web" ? 8 : 6 },
  btnGhost: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#e2e8f0",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "#cbd5e1",
  },
  btnGhostText: { color: "#394e6a", fontWeight: "700" },
  buildingHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  quickSelectBtn: {
    flexDirection: "row", alignItems: "center", backgroundColor: "#e0ecff", borderColor: "#93c5fd", borderWidth: 1,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
  },
  quickSelectText: { color: "#1d4ed8", fontWeight: "800", letterSpacing: 0.3, fontSize: 12 },
  chipsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chipsRowHorizontal: {
    paddingRight: 4,
    gap: 8,
    alignItems: "center",
  },
  chip: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#f8fafc",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipActive: { backgroundColor: "#e0ecff", borderColor: "#93c5fd" },
  chipIdle: {},
  chipText: { fontWeight: "700" },
  chipTextActive: { color: "#1d4ed8" },
  chipTextIdle: { color: "#334155" },
  rowCard: {
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
    backgroundColor: "#fff",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    ...(Platform.select({
      web: { boxShadow: "0 8px 24px rgba(16,42,67,0.05)" as any },
      default: { elevation: 1 },
    }) as any),
  },
  rowCardMobile: { flexDirection: "column", alignItems: "stretch" },
  rowTitle: { fontSize: 15, fontWeight: "900", color: "#0f172a" },
  rowSub: { fontSize: 12, color: "#64748b", marginTop: 2 },
  rowActions: { width: 160, flexDirection: "row", justifyContent: "flex-end", alignItems: "center" },
  rowActionsMobile: { flexDirection: "row", gap: 8, marginTop: 10, justifyContent: "flex-start", alignItems: "center" },
  actionBtn: { height: 36, paddingHorizontal: 12, borderRadius: 10, flexDirection: "row", alignItems: "center", gap: 6 },
  actionText: { fontWeight: "800" },
  actionTextPrimary: { color: "#fff" },
  primaryBtn: { backgroundColor: "#2563eb" },
  btnDisabled: { opacity: 0.65 },
  loader: { paddingVertical: 20, alignItems: "center", gap: 8 },
  loadingText: { color: "#64748b", fontSize: 12 },
  emptyWrap: { alignItems: "center", paddingVertical: 40, gap: 6 },
  emptyTitle: { fontSize: 14, color: "#475569", fontWeight: "800" },
  emptyHint: { fontSize: 12, color: "#94a3b8" },
  overlay: { flex: 1, backgroundColor: "rgba(2,6,23,0.45)", justifyContent: "center", padding: 16 },
  modalCard: {
    marginHorizontal: 8,
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: "#eef2f7",
    ...(Platform.select({
      web: { maxWidth: 560, alignSelf: "center", boxShadow: "0 14px 36px rgba(2,6,23,0.25)" as any },
      default: { elevation: 4 },
    }) as any),
  },
  modalHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modalTitle: { fontSize: 16, fontWeight: "900", color: "#0b2447" },
  modalDivider: { height: StyleSheet.hairlineWidth, backgroundColor: "#e5e7eb", marginVertical: 10 },
  summaryBox: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#eff6ff", borderColor: "#bfdbfe", borderWidth: StyleSheet.hairlineWidth, padding: 8, borderRadius: 10
  },
  summaryText: { fontSize: 13, color: "#1e40af" },
  helpText: { marginTop: 6, fontSize: 12, color: "#94a3b8" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 12 },
  label: {
    fontSize: 12,
    color: "#475569", 
    fontWeight: "800",
    letterSpacing: 0.2,
    marginBottom: 6,
  },
  select: {
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  selectEmphasis: {
    borderColor: "rgba(8,44,172,0.25)",
    backgroundColor: "rgba(8,44,172,0.03)",
  },
  smallBtn: {
  minHeight: 36,
  paddingHorizontal: 12,
  paddingVertical: 8,
  borderRadius: 10,
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
},
smallBtnText: {
  fontSize: 13,
  fontWeight: "800",
},
ghostBtn: {
  backgroundColor: "#f1f5f9",         
  borderWidth: 1,
  borderColor: "#e2e8f0",             
},
ghostBtnText: {
  color: "#1f2937",                   
},
});