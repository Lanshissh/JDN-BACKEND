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
  useWindowDimensions,
  Dimensions,
} from "react-native";
import axios from "axios";
import { Picker } from "@react-native-picker/picker";
import { Ionicons } from "@expo/vector-icons";
import { BASE_API } from "../../constants/api";
type Role = "admin" | "operator" | "biller" | "reader";
type Util = "electric" | "water" | "lpg";
type UserRow = {
  user_id: string;
  user_fullname: string;
  user_roles: Role[];      
  building_ids: string[];  
  utility_role: Util[];    
  last_updated?: string;
  updated_by?: string;
};
type User = {
  user_id: string;
  user_fullname: string;
  role: Role;              
  buildings: string[];     
  utilities: Util[];
  last_updated?: string;
  updated_by?: string;
};
type Building = {
  building_id: string;
  building_name: string;
};
function notify(title: string, message?: string) {
  if (Platform.OS === "web" && typeof window !== "undefined" && (window as any).alert) {
    (window as any).alert(message ? `${title}\n\n${message}` : title);
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
const dateOf = (s?: string) => (s ? Date.parse(s) || 0 : 0);
const Chip = ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) => (
  <TouchableOpacity onPress={onPress} style={[styles.chip, active ? styles.chipActive : styles.chipIdle]}>
    <Text style={[styles.chipText, active ? styles.chipTextActive : styles.chipTextIdle]}>{label}</Text>
  </TouchableOpacity>
);
export default function AccountsPanel({ token }: { token: string | null }) {
  const { width } = useWindowDimensions();
  const isMobile = width < 640;
  const [busy, setBusy] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [query, setQuery] = useState("");
  const [buildingFilter, setBuildingFilter] = useState<string>("");
  const [roleFilter, setRoleFilter] = useState<"" | Role>("");
  type SortMode = "newest" | "oldest" | "idAsc" | "idDesc";
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);
  const [c_fullname, setC_fullname] = useState("");
  const [c_password, setC_password] = useState("");
  const [c_role, setC_role] = useState<Role>("operator");
  const [c_buildingId, setC_buildingId] = useState("");
  const [c_utils, setC_utils] = useState<Util[]>([]);
  const [editVisible, setEditVisible] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [e_fullname, setE_fullname] = useState("");
  const [e_password, setE_password] = useState("");
  const [e_role, setE_role] = useState<Role>("operator");
  const [e_buildingId, setE_buildingId] = useState("");
  const [e_utils, setE_utils] = useState<Util[]>([]);
  const authHeader = useMemo(() => ({ Authorization: `Bearer ${token ?? ""}` }), [token]);
  const api = useMemo(() => axios.create({ baseURL: BASE_API, headers: authHeader, timeout: 15000 }), [authHeader]);
  const loadAll = async () => {
    if (!token) { setBusy(false); notify("Not logged in", "Please log in to manage accounts."); return; }
    try {
      setBusy(true);
      const [uRes, bRes] = await Promise.all([
        api.get<UserRow[]>("/users"),
        api.get<Building[]>("/buildings"),
      ]);
      const normalized: User[] = (uRes.data || []).map((u) => {
        const role = (Array.isArray(u.user_roles) && u.user_roles.length ? u.user_roles[0] : "operator") as Role;
        const buildings = Array.isArray(u.building_ids) ? u.building_ids.map(String) : [];
        const utils = Array.isArray(u.utility_role) ? (u.utility_role as Util[]) : [];
        return {
          user_id: String(u.user_id),
          user_fullname: String(u.user_fullname ?? ""),
          role,
          buildings,
          utilities: utils,
          last_updated: u.last_updated,
          updated_by: u.updated_by,
        };
      });
      setUsers(normalized);
      setBuildings(bRes.data || []);
      if (!c_buildingId && (bRes.data?.length ?? 0) > 0) setC_buildingId(bRes.data[0].building_id);
    } catch (err: any) {
      notify("Load failed", errorText(err, "Connection error."));
    } finally { setBusy(false); }
  };
  useEffect(() => { loadAll(); }, [token]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = users;
    if (buildingFilter) {
      list = list.filter((u) => u.buildings.includes(buildingFilter));
    }
    if (roleFilter) {
      list = list.filter((u) => u.role === roleFilter);
    }
    if (q) {
      list = list.filter((u) =>
        [u.user_id, u.user_fullname, u.role, ...u.buildings, ...(u.utilities || [])]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      );
    }
    return list;
  }, [users, query, buildingFilter, roleFilter]);
  const sorted = useMemo(() => {
    const arr = [...filtered];
    switch (sortMode) {
      case "oldest": arr.sort((a, b) => dateOf(a.last_updated) - dateOf(b.last_updated)); break;
      case "idAsc":  arr.sort((a, b) => cmp(a.user_id, b.user_id)); break;
      case "idDesc": arr.sort((a, b) => cmp(b.user_id, a.user_id)); break;
      case "newest":
      default:       arr.sort((a, b) => dateOf(b.last_updated) - dateOf(a.last_updated)); break;
    }
    return arr;
  }, [filtered, sortMode]);
  const onCreate = async () => {
    const fullname = c_fullname.trim();
    if (!fullname || !c_password) { notify("Missing info", "Please enter Full name and Password."); return; }
    if (c_role !== "admin" && !c_buildingId) { notify("Missing building", "Select a Building for non-admin roles."); return; }
    try {
      setSubmitting(true);
      const body: any = {
        user_fullname: fullname,
        user_password: c_password,
        user_roles: [c_role],
        building_ids: c_role === "admin" ? [] : [c_buildingId],
        utility_role: c_role === "admin" ? [] : c_utils,
      };
      await api.post("/users", body);
      setCreateVisible(false);
      setC_fullname(""); setC_password(""); setC_role("operator"); setC_utils([]);
      await loadAll();
      notify("Success", "Account created.");
    } catch (err: any) {
      notify("Create failed", errorText(err));
    } finally { setSubmitting(false); }
  };
  const openEdit = (u: User) => {
    setEditUser(u);
    setE_fullname(u.user_fullname);
    setE_password("");
    setE_role(u.role);
    setE_buildingId(u.buildings[0] || "");
    setE_utils(u.utilities || []);
    setEditVisible(true);
  };
  const onUpdate = async () => {
    if (!editUser) return;
    if (e_role !== "admin" && !e_buildingId) { notify("Missing building", "Select a Building for non-admin roles."); return; }
    try {
      setSubmitting(true);
      const body: any = {
        user_fullname: e_fullname,
        user_roles: [e_role],
        building_ids: e_role === "admin" ? [] : [e_buildingId],
        utility_role: e_role === "admin" ? [] : e_utils,
      };
      if (e_password.trim()) body.user_password = e_password.trim();
      await api.put(`/users/${encodeURIComponent(editUser.user_id)}`, body);
      setEditVisible(false);
      await loadAll();
      notify("Updated", "Account updated successfully.");
    } catch (err: any) {
      notify("Update failed", errorText(err));
    } finally { setSubmitting(false); }
  };
  const onDelete = async (u: User) => {
    if (Platform.OS === "web" && typeof window !== "undefined" && (window as any).confirm) {
      const ok = (window as any).confirm(`Delete ${u.user_fullname} (${u.user_id})?`);
      if (!ok) return;
    } else {
      const buttons: any[] = [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: async () => { await doDelete(); } },
      ];
      return Alert.alert("Delete account?", `${u.user_fullname} (${u.user_id})`, buttons);
    }
    await doDelete();
    async function doDelete() {
      try {
        setSubmitting(true);
        await api.delete(`/users/${encodeURIComponent(u.user_id)}`);
        await loadAll();
        notify("Deleted", "Account deleted.");
      } catch (err: any) {
        notify("Delete failed", errorText(err));
      } finally { setSubmitting(false); }
    }
  };
  return (
    <View style={styles.page}>
      <View style={styles.grid}>
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Manage Accounts</Text>
            <TouchableOpacity style={styles.btn} onPress={() => setCreateVisible(true)}>
              <Text style={styles.btnText}>+ Create Account</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.filtersBar}>
            <View style={[styles.searchWrap, { flex: 1 }]}>
              <Ionicons name="search" size={16} color="#94a3b8" style={{ marginRight: 6 }} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search by ID, name, role, building…"
                placeholderTextColor="#9aa5b1"
                style={styles.search}
              />
            </View>
            <TouchableOpacity style={styles.btnGhost} onPress={() => setFiltersVisible(true)}>
              <Ionicons name="options-outline" size={16} color="#394e6a" style={{ marginRight: 6 }} />
              <Text style={styles.btnGhostText}>Filters</Text>
            </TouchableOpacity>
          </View>
          <View style={{ marginTop: 6, marginBottom: 15 }}>
            <View style={styles.buildingHeaderRow}>
              <Text style={styles.dropdownLabel}>Building</Text>
            </View>
            {isMobile ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipsRowHorizontal}
              >
                <Chip label="All" active={buildingFilter === ""} onPress={() => setBuildingFilter("")} />
                {buildings.map((b) => (
                  <Chip
                    key={b.building_id}
                    label={b.building_name || b.building_id}
                    active={buildingFilter === b.building_id}
                    onPress={() => setBuildingFilter(b.building_id)}
                  />
                ))}
              </ScrollView>
            ) : (
              <View style={styles.chipsRow}>
                <Chip label="All" active={buildingFilter === ""} onPress={() => setBuildingFilter("")} />
                {buildings.map((b) => (
                  <Chip
                    key={b.building_id}
                    label={b.building_name || b.building_id}
                    active={buildingFilter === b.building_id}
                    onPress={() => setBuildingFilter(b.building_id)}
                  />
                ))}
              </View>
            )}
          </View>
          {busy ? (
            <View style={styles.loader}><ActivityIndicator /></View>
          ) : (
            <FlatList
              data={sorted}
              keyExtractor={(u) => u.user_id}
              style={{ flex: 1 }}
              contentContainerStyle={sorted.length === 0 ? styles.emptyPad : { paddingBottom: 24 }}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Ionicons name="person-outline" size={42} color="#cbd5e1" />
                  <Text style={styles.emptyTitle}>No accounts</Text>
                  <Text style={styles.emptyText}>Try adjusting your search or create a new one.</Text>
                </View>
              }
              renderItem={({ item }) => (
                <View style={[styles.row, isMobile && styles.rowMobile]}>
                  <View style={styles.rowMain}>
                    <Text style={styles.rowTitle}>
                      {item.user_fullname} <Text style={styles.rowSub}>({item.user_id})</Text>
                    </Text>
                    <Text style={styles.rowMeta}>
                      Role: {item.role}
                      {item.buildings.length ? ` • Building: ${item.buildings.join(", ")}` : " • Building: —"}
                      {item.utilities.length ? ` • Utilities: ${item.utilities.join(", ")}` : ""}
                    </Text>
                    {item.last_updated ? (
                      <Text style={styles.rowMetaSmall}>
                        Updated {new Date(item.last_updated).toLocaleString()} {item.updated_by ? `• by ${item.updated_by}` : ""}
                      </Text>
                    ) : null}
                  </View>
                  {isMobile ? (
                    <View style={styles.rowActionsMobile}>
                      <TouchableOpacity style={[styles.actionBtn, styles.actionEdit]} onPress={() => openEdit(item)}>
                        <Ionicons name="create-outline" size={16} color="#1f2937" />
                        <Text style={[styles.actionText, styles.actionEditText]}>Update</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.actionBtn, styles.actionDelete]} onPress={() => onDelete(item)}>
                        <Ionicons name="trash-outline" size={16} color="#fff" />
                        <Text style={[styles.actionText, styles.actionDeleteText]}>Delete</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={styles.rowActions}>
                      <TouchableOpacity style={[styles.actionBtn, styles.actionEdit]} onPress={() => openEdit(item)}>
                        <Ionicons name="create-outline" size={16} color="#1f2937" />
                        <Text style={[styles.actionText, styles.actionEditText]}>Update</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.actionBtn, styles.actionDelete]} onPress={() => onDelete(item)}>
                        <Ionicons name="trash-outline" size={16} color="#fff" />
                        <Text style={[styles.actionText, styles.actionDeleteText]}>Delete</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              )}
            />
          )}
        </View>
        <Modal visible={filtersVisible} transparent animationType="fade" onRequestClose={() => setFiltersVisible(false)}>
          <View style={styles.promptOverlay}>
            <View style={styles.promptCard}>
              <Text style={styles.modalTitle}>Filters & Sort</Text>
              <View style={styles.modalDivider} />
              <Text style={styles.dropdownLabel}>Role</Text>
              <View style={styles.chipsRow}>
                {[{ label: "All", value: "" }, "admin", "operator", "biller", "reader"].map((opt) =>
                  typeof opt === "string" ? (
                    <Chip
                      key={opt}
                      label={opt}
                      active={roleFilter === opt}
                      onPress={() => setRoleFilter(opt as Role)}
                    />
                  ) : (
                    <Chip
                      key="all"
                      label={opt.label}
                      active={roleFilter === (opt.value as any)}
                      onPress={() => setRoleFilter(opt.value as any)}
                    />
                  )
                )}
              </View>
              <Text style={[styles.dropdownLabel, { marginTop: 10 }]}>Sort by</Text>
              <View style={styles.chipsRow}>
                <Chip label="Newest" active={sortMode === "newest"} onPress={() => setSortMode("newest")} />
                <Chip label="Oldest" active={sortMode === "oldest"} onPress={() => setSortMode("oldest")} />
                <Chip label="ID ↑" active={sortMode === "idAsc"} onPress={() => setSortMode("idAsc")} />
                <Chip label="ID ↓" active={sortMode === "idDesc"} onPress={() => setSortMode("idDesc")} />
              </View>
              <View style={styles.modalActions}>
                <TouchableOpacity style={[styles.btn]} onPress={() => setFiltersVisible(false)}>
                  <Text style={styles.btnText}>Done</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
        <Modal visible={createVisible} animationType="fade" transparent onRequestClose={() => setCreateVisible(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalWrap}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Create Account</Text>
              <View style={styles.modalDivider} />
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Full name</Text>
                  <TextInput
                    value={c_fullname}
                    onChangeText={setC_fullname}
                    placeholder="e.g. Juan Dela Cruz"
                    placeholderTextColor="#9aa5b1"
                    style={styles.input}
                  />
                </View>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Password</Text>
                  <TextInput
                    value={c_password}
                    onChangeText={setC_password}
                    placeholder="Enter password"
                    placeholderTextColor="#9aa5b1"
                    style={styles.input}
                    secureTextEntry
                  />
                </View>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Role</Text>
                  <View style={styles.pickerWrapper}>
                    <Picker selectedValue={c_role} onValueChange={(v) => setC_role(v as Role)} style={styles.picker}>
                      <Picker.Item label="Admin" value="admin" />
                      <Picker.Item label="Operator" value="operator" />
                      <Picker.Item label="Biller" value="biller" />
                      <Picker.Item label="Reader" value="reader" />
                    </Picker>
                  </View>
                </View>
                {c_role !== "admin" && (
                  <>
                    <View style={styles.inputRow}>
                      <Text style={styles.inputLabel}>Building</Text>
                      <View style={styles.pickerWrapper}>
                        <Picker selectedValue={c_buildingId} onValueChange={(v) => setC_buildingId(String(v))} style={styles.picker}>
                          {buildings.map((b) => (
                            <Picker.Item key={b.building_id} label={b.building_name || b.building_id} value={b.building_id} />
                          ))}
                        </Picker>
                      </View>
                    </View>
                    <Text style={styles.sectionTitle}>Utilities</Text>
                    <View style={styles.chipsRow}>
                      {(["electric", "water", "lpg"] as Util[]).map((u) => {
                        const active = c_utils.includes(u);
                        return (
                          <Chip
                            key={u}
                            label={u}
                            active={active}
                            onPress={() => {
                              setC_utils(active ? c_utils.filter((x) => x !== u) : [...c_utils, u]);
                            }}
                          />
                        );
                      })}
                    </View>
                  </>
                )}
              </ScrollView>
              <View style={styles.modalActions}>
                <TouchableOpacity style={[styles.btnGhostAlt]} onPress={() => setCreateVisible(false)}>
                  <Text style={styles.btnGhostTextAlt}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, submitting && styles.btnDisabled]} onPress={onCreate} disabled={submitting}>
                  <Text style={styles.btnText}>{submitting ? "Saving…" : "Create"}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
        <Modal visible={editVisible} animationType="fade" transparent onRequestClose={() => setEditVisible(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalWrap}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Update Account</Text>
              <View style={styles.modalDivider} />
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
                {editUser && (
                  <>
                    <View style={styles.inputRow}>
                      <Text style={styles.inputLabel}>Full name</Text>
                      <TextInput
                        value={e_fullname}
                        onChangeText={setE_fullname}
                        placeholder="e.g. Juan Dela Cruz"
                        placeholderTextColor="#9aa5b1"
                        style={styles.input}
                      />
                    </View>
                    <View style={styles.inputRow}>
                      <Text style={styles.inputLabel}>New password (optional)</Text>
                      <TextInput
                        value={e_password}
                        onChangeText={setE_password}
                        placeholder="Leave blank to keep current"
                        placeholderTextColor="#9aa5b1"
                        style={styles.input}
                        secureTextEntry
                      />
                    </View>
                    <View style={styles.inputRow}>
                      <Text style={styles.inputLabel}>Role</Text>
                      <View style={styles.pickerWrapper}>
                        <Picker selectedValue={e_role} onValueChange={(v) => setE_role(v as Role)} style={styles.picker}>
                          <Picker.Item label="Admin" value="admin" />
                          <Picker.Item label="Operator" value="operator" />
                          <Picker.Item label="Biller" value="biller" />
                          <Picker.Item label="Reader" value="reader" />
                        </Picker>
                      </View>
                    </View>
                    {e_role !== "admin" && (
                      <>
                        <View style={styles.inputRow}>
                          <Text style={styles.inputLabel}>Building</Text>
                          <View style={styles.pickerWrapper}>
                            <Picker
                              selectedValue={e_buildingId}
                              onValueChange={(v) => setE_buildingId(String(v))}
                              style={styles.picker}
                            >
                              {buildings.map((b) => (
                                <Picker.Item key={b.building_id} label={b.building_name || b.building_id} value={b.building_id} />
                              ))}
                            </Picker>
                          </View>
                        </View>
                        <Text style={styles.sectionTitle}>Utilities</Text>
                        <View style={styles.chipsRow}>
                          {(["electric", "water", "lpg"] as Util[]).map((u) => {
                            const active = e_utils.includes(u);
                            return (
                              <Chip
                                key={u}
                                label={u}
                                active={active}
                                onPress={() => {
                                  setE_utils(active ? e_utils.filter((x) => x !== u) : [...e_utils, u]);
                                }}
                              />
                            );
                          })}
                        </View>
                      </>
                    )}
                  </>
                )}
              </ScrollView>
              <View style={styles.modalActions}>
                <TouchableOpacity style={[styles.btnGhostAlt]} onPress={() => setEditVisible(false)}>
                  <Text style={styles.btnGhostTextAlt}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, submitting && styles.btnDisabled]} onPress={onUpdate} disabled={submitting}>
                  <Text style={styles.btnText}>{submitting ? "Saving…" : "Save"}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </View>
    </View>
  );
}
const W = Dimensions.get("window").width;
const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0 },
  grid: { flex: 1, padding: 14, gap: 14, minHeight: 0 },
  card: {
    flex: 1,
    minHeight: 0,
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 14,
    ...(Platform.select({
      web: { boxShadow: "0 10px 30px rgba(15, 23, 42, 0.08)" } as any,
      default: { elevation: 2 },
    }) as any),
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  cardTitle: { fontSize: 18, fontWeight: "700", color: "#0f172a" },
  btn: { backgroundColor: "#2563eb", paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10 },
  btnText: { color: "#fff", fontWeight: "700" },
  btnDisabled: { opacity: 0.6 },
  filtersBar: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f1f5f9",
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 40,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  search: { flex: 1, height: 40, color: "#0f172a" },
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
  loader: { paddingVertical: 24, alignItems: "center", justifyContent: "center" },
  row: {
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    backgroundColor: "#fff",
    flexDirection: "row",
    alignItems: "center",
  },
  rowMobile: { flexDirection: "column", alignItems: "stretch" },
  rowMain: { flex: 1, paddingRight: 10 },
  rowTitle: { fontSize: 16, fontWeight: "700", color: "#0f172a" },
  rowSub: { color: "#64748b", fontWeight: "600" },
  rowMeta: { color: "#334155", marginTop: 6 },
  rowMetaSmall: { color: "#94a3b8", marginTop: 2, fontSize: 12 },
  rowActions: { width: 200, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8 },
  rowActionsMobile: { flexDirection: "row", gap: 8, marginTop: 10, justifyContent: "flex-start", alignItems: "center" },
  actionBtn: { height: 36, paddingHorizontal: 12, borderRadius: 10, flexDirection: "row", alignItems: "center", gap: 6 },
  actionEdit: { backgroundColor: "#e2e8f0" },
  actionDelete: { backgroundColor: "#ef4444" },
  actionText: { fontWeight: "700" },
  actionEditText: { color: "#1f2937" },
  actionDeleteText: { color: "#fff" },
  emptyPad: { paddingVertical: 30 },
  empty: { alignItems: "center", gap: 6 },
  emptyTitle: { fontWeight: "800", color: "#0f172a" },
  emptyText: { color: "#94a3b8" },
  buildingHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chipsRowHorizontal: { paddingRight: 4, gap: 8 },
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
  modalWrap: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.36)",
    alignItems: "center",
    justifyContent: "center",
    padding: 14,
  },
  modalCard: {
    backgroundColor: "#fff",
    borderRadius: 14,
    width: "100%",
    maxWidth: 720,
    padding: 14,
    ...(Platform.select({
      web: { boxShadow: "0 14px 44px rgba(15, 23, 42, 0.16)" } as any,
      default: { elevation: 3 },
    }) as any),
  },
  modalTitle: { fontSize: 18, fontWeight: "800", color: "#0f172a" },
  modalDivider: { height: 1, backgroundColor: "#e2e8f0", marginVertical: 10 },
  modalActions: { marginTop: 10, flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  btnGhostAlt: {
    backgroundColor: "#f1f5f9",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  btnGhostTextAlt: { color: "#334155", fontWeight: "700" },
  inputRow: { marginBottom: 10 },
  inputLabel: { color: "#334155", fontWeight: "700", marginBottom: 6 },
  input: {
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 10,
    height: 40,
    paddingHorizontal: 10,
    color: "#0f172a",
  },
  sectionTitle: { marginTop: 10, marginBottom: 6, fontWeight: "800", color: "#0f172a" },
  pickerWrapper: { borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 10, overflow: "hidden" },
  picker: { height: 40 },
  promptOverlay: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.36)",
    alignItems: "center",
    justifyContent: "center",
    padding: 14,
  },
  promptCard: {
    backgroundColor: "#fff",
    borderRadius: 14,
    width: "100%",
    maxWidth: 560,
    padding: 14,
    ...(Platform.select({
      web: { boxShadow: "0 14px 44px rgba(15, 23, 42, 0.16)" } as any,
      default: { elevation: 3 },
    }) as any),
  },
  dropdownLabel: { fontWeight: "800", color: "#0f172a", marginBottom: 8, textTransform: "none" },
});