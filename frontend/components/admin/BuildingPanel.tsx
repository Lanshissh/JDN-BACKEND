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
} from "react-native";
import axios from "axios";
import { Ionicons } from "@expo/vector-icons";
import { BASE_API } from "../../constants/api";

type Props = { token: string | null };

type Building = {
  building_id: string;
  building_name: string;
  erate_perKwH?: number | null;
  emin_con?: number | null;
  wrate_perCbM?: number | null;
  wmin_con?: number | null;
  lrate_perKg?: number | null;
  markup_rate?: number | null;
  penalty_rate?: number | null;
  last_updated?: string | null;
  updated_by?: string | null;
};

type SortMode =
  | "newest"
  | "oldest"
  | "nameAsc"
  | "nameDesc"
  | "idAsc"
  | "idDesc";

const fmtDate = (iso?: string | null) => {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : String(iso);
};

const toNumOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

function notify(title: string, message?: string) {
  if (Platform.OS === "web" && typeof window !== "undefined" && window.alert) {
    window.alert(message ? `${title}\n${message}` : title);
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
  try {
    return JSON.stringify(d ?? err);
  } catch {
    return fallback;
  }
}

const Chip = ({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) => (
  <TouchableOpacity
    onPress={onPress}
    style={[styles.chip, active ? styles.chipActive : styles.chipIdle]}
  >
    <Text
      style={[
        styles.chipText,
        active ? styles.chipTextActive : styles.chipTextIdle,
      ]}
    >
      {label}
    </Text>
  </TouchableOpacity>
);

export default function BuildingPanel({ token }: Props) {
  const { width } = useWindowDimensions();
  const isMobile = width < 640;

  const [busy, setBusy] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [rows, setRows] = useState<Building[]>([]);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [hasAnyRate, setHasAnyRate] = useState(false);
  const [onlyNonZero, setOnlyNonZero] = useState(false);

  const [createVisible, setCreateVisible] = useState(false);
  const [c_name, setC_name] = useState("");
  const [c_eRate, setC_eRate] = useState("");
  const [c_eMin, setC_eMin] = useState("");
  const [c_wRate, setC_wRate] = useState("");
  const [c_wMin, setC_wMin] = useState("");
  const [c_lRate, setC_lRate] = useState("");
  const [c_markup, setC_markup] = useState("");
  const [c_penalty, setC_penalty] = useState("");

  const [editVisible, setEditVisible] = useState(false);
  const [editRow, setEditRow] = useState<Building | null>(null);
  const [e_name, setE_name] = useState("");
  const [e_eRate, setE_eRate] = useState("");
  const [e_eMin, setE_eMin] = useState("");
  const [e_wRate, setE_wRate] = useState("");
  const [e_wMin, setE_wMin] = useState("");
  const [e_lRate, setE_lRate] = useState("");
  const [e_markup, setE_markup] = useState("");
  const [e_penalty, setE_penalty] = useState("");

  const authHeader = useMemo(
    () => ({ Authorization: `Bearer ${token ?? ""}` }),
    [token]
  );
  const api = useMemo(
    () =>
      axios.create({
        baseURL: BASE_API,
        headers: authHeader,
        timeout: 15000,
      }),
    [authHeader]
  );

  const basePath = "/buildings";

  useEffect(() => {
    loadAll();
  }, [token]);

  const loadAll = async () => {
    if (!token) {
      setBusy(false);
      notify("Not logged in", "Please log in to manage buildings.");
      return;
    }
    try {
      setBusy(true);
      const res = await api.get<Building[]>(basePath);
      setRows(res.data || []);
    } catch (err) {
      notify("Load failed", errorText(err, "Could not load buildings."));
    } finally {
      setBusy(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const nz = (v: number | null | undefined) =>
      v == null ? false : onlyNonZero ? Number(v) > 0 : true;

    return rows.filter((r) => {
      const textOk = !q
        ? true
        : [r.building_id, r.building_name, r.updated_by].some((v) =>
            String(v ?? "").toLowerCase().includes(q)
          );

      const rateOk = hasAnyRate
        ? nz(r.erate_perKwH) ||
          nz(r.wrate_perCbM) ||
          nz(r.lrate_perKg) ||
          nz(r.markup_rate) ||
          nz(r.penalty_rate)
        : true;

      return textOk && rateOk;
    });
  }, [rows, query, hasAnyRate, onlyNonZero]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    switch (sortMode) {
      case "nameAsc":
        return arr.sort((a, b) =>
          (a.building_name || "").localeCompare(b.building_name || "")
        );
      case "nameDesc":
        return arr.sort((a, b) =>
          (b.building_name || "").localeCompare(a.building_name || "")
        );
      case "idAsc":
        return arr.sort((a, b) =>
          (a.building_id || "").localeCompare(
            b.building_id || "",
            undefined,
            { numeric: true }
          )
        );
      case "idDesc":
        return arr.sort((a, b) =>
          (b.building_id || "").localeCompare(
            a.building_id || "",
            undefined,
            { numeric: true }
          )
        );
      case "oldest":
        return arr.sort(
          (a, b) =>
            (Date.parse(a.last_updated || "") || 0) -
            (Date.parse(b.last_updated || "") || 0)
        );
      case "newest":
      default:
        return arr.sort(
          (a, b) =>
            (Date.parse(b.last_updated || "") || 0) -
            (Date.parse(a.last_updated || "") || 0)
        );
    }
  }, [filtered, sortMode]);

  const onCreate = async () => {
    const building_name = c_name.trim();
    if (!building_name) {
      notify("Missing info", "Please enter a building name.");
      return;
    }
    try {
      setSubmitting(true);
      await api.post(basePath, {
        building_name,
        erate_perKwH: toNumOrNull(c_eRate),
        emin_con: toNumOrNull(c_eMin),
        wrate_perCbM: toNumOrNull(c_wRate),
        wmin_con: toNumOrNull(c_wMin),
        lrate_perKg: toNumOrNull(c_lRate),
        markup_rate: toNumOrNull(c_markup),
        penalty_rate: toNumOrNull(c_penalty),
      });
      setCreateVisible(false);
      setC_name("");
      setC_eRate("");
      setC_eMin("");
      setC_wRate("");
      setC_wMin("");
      setC_lRate("");
      setC_markup("");
      setC_penalty("");
      await loadAll();
      notify("Success", "Building created.");
    } catch (err) {
      notify("Create failed", errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (row: Building) => {
    setEditRow(row);
    setE_name(row.building_name || "");
    setE_eRate(
      row.erate_perKwH != null ? String(row.erate_perKwH) : ""
    );
    setE_eMin(row.emin_con != null ? String(row.emin_con) : "");
    setE_wRate(
      row.wrate_perCbM != null ? String(row.wrate_perCbM) : ""
    );
    setE_wMin(row.wmin_con != null ? String(row.wmin_con) : "");
    setE_lRate(
      row.lrate_perKg != null ? String(row.lrate_perKg) : ""
    );
    setE_markup(
      row.markup_rate != null ? String(row.markup_rate) : ""
    );
    setE_penalty(
      row.penalty_rate != null ? String(row.penalty_rate) : ""
    );
    setEditVisible(true);
  };

  const onUpdate = async () => {
    if (!editRow) return;
    const building_name = e_name.trim();
    if (!building_name) {
      notify("Missing info", "Please enter a building name.");
      return;
    }
    try {
      setSubmitting(true);
      await api.put(`${basePath}/${encodeURIComponent(editRow.building_id)}`, {
        building_name,
        erate_perKwH: toNumOrNull(e_eRate),
        emin_con: toNumOrNull(e_eMin),
        wrate_perCbM: toNumOrNull(e_wRate),
        wmin_con: toNumOrNull(e_wMin),
        lrate_perKg: toNumOrNull(e_lRate),
        markup_rate: toNumOrNull(e_markup),
        penalty_rate: toNumOrNull(e_penalty),
      });
      setEditVisible(false);
      await loadAll();
      notify("Updated", "Building updated.");
    } catch (err) {
      notify("Update failed", errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = (row: Building) => {
    const go = async () => {
      try {
        setSubmitting(true);
        await api.delete(
          `${basePath}/${encodeURIComponent(row.building_id)}`
        );
        await loadAll();
        notify("Deleted", "Building removed.");
      } catch (err) {
        notify("Delete failed", errorText(err));
      } finally {
        setSubmitting(false);
      }
    };

    if (Platform.OS === "web" && typeof window !== "undefined" && window.confirm) {
      if (window.confirm(`Delete ${row.building_name || row.building_id}?`)) go();
    } else {
      Alert.alert(
        "Confirm delete",
        `Delete ${row.building_name || row.building_id}?`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: go },
        ]
      );
    }
  };

  return (
    <View style={styles.page}>
      <View style={styles.grid}>
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Buildings</Text>
            <TouchableOpacity
              style={styles.btn}
              onPress={() => setCreateVisible(true)}
            >
              <Text style={styles.btnText}>+ New</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.filtersBar}>
            <View style={[styles.searchWrap, { flex: 1 }]}>
              <Ionicons
                name="search"
                size={16}
                color="#94a3b8"
                style={{ marginRight: 6 }}
              />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search by ID or name…"
                placeholderTextColor="#9aa5b1"
                style={styles.search}
              />
            </View>
            <TouchableOpacity
              style={styles.btnGhost}
              onPress={() => setFiltersVisible(true)}
            >
              <Ionicons
                name="options-outline"
                size={16}
                color="#394e6a"
                style={{ marginRight: 6 }}
              />
              <Text style={styles.btnGhostText}>Filters</Text>
            </TouchableOpacity>
          </View>

          {busy ? (
            <View style={styles.loader}>
              <ActivityIndicator />
            </View>
          ) : (
            <FlatList
              data={sorted}
              keyExtractor={(r) => r.building_id}
              style={{ flex: 1 }}
              contentContainerStyle={
                sorted.length === 0
                  ? styles.emptyPad
                  : { paddingBottom: 24 }
              }
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Ionicons
                    name="business-outline"
                    size={42}
                    color="#cbd5e1"
                  />
                  <Text style={styles.emptyTitle}>No buildings</Text>
                  <Text style={styles.emptyText}>
                    Try adjusting your search or create a new record.
                  </Text>
                </View>
              }
              renderItem={({ item }) => (
                <View
                  style={[
                    styles.row,
                    isMobile && styles.rowMobile,
                  ]}
                >
                  <View style={styles.rowMain}>
                    <Text style={styles.rowTitle}>
                      {item.building_name || "(No name)"}{" "}
                      <Text style={styles.rowSub}>
                        ({item.building_id})
                      </Text>
                    </Text>
                    <Text style={styles.rowMeta}>
                      ELECTRIC: {item.erate_perKwH ?? "—"} ₱/kWh (min{" "}
                      {item.emin_con ?? "—"} kWh)
                    </Text>
                    <Text style={styles.rowMeta}>
                      WATER: {item.wrate_perCbM ?? "—"} ₱/m³ (min{" "}
                      {item.wmin_con ?? "—"} m³)
                    </Text>
                    <Text style={styles.rowMeta}>
                      LPG: {item.lrate_perKg ?? "—"} ₱/kg • Markup:{" "}
                      {item.markup_rate ?? "—"} • Penalty:{" "}
                      {item.penalty_rate ?? "—"}
                    </Text>
                    {item.last_updated ? (
                      <Text style={styles.rowMetaSmall}>
                        Updated {fmtDate(item.last_updated)}{" "}
                        {item.updated_by
                          ? `• by ${item.updated_by}`
                          : ""}
                      </Text>
                    ) : null}
                  </View>
                  {isMobile ? (
                    <View style={styles.rowActionsMobile}>
                      <TouchableOpacity
                        style={[
                          styles.actionBtn,
                          styles.actionEdit,
                        ]}
                        onPress={() => openEdit(item)}
                      >
                        <Ionicons
                          name="create-outline"
                          size={16}
                          color="#1f2937"
                        />
                        <Text
                          style={[
                            styles.actionText,
                            styles.actionEditText,
                          ]}
                        >
                          Update
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.actionBtn,
                          styles.actionDelete,
                        ]}
                        onPress={() => onDelete(item)}
                      >
                        <Ionicons
                          name="trash-outline"
                          size={16}
                          color="#fff"
                        />
                        <Text
                          style={[
                            styles.actionText,
                            styles.actionDeleteText,
                          ]}
                        >
                          Delete
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={styles.rowActions}>
                      <TouchableOpacity
                        style={[
                          styles.actionBtn,
                          styles.actionEdit,
                        ]}
                        onPress={() => openEdit(item)}
                      >
                        <Ionicons
                          name="create-outline"
                          size={16}
                          color="#1f2937"
                        />
                        <Text
                          style={[
                            styles.actionText,
                            styles.actionEditText,
                          ]}
                        >
                          Update
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.actionBtn,
                          styles.actionDelete,
                        ]}
                        onPress={() => onDelete(item)}
                      >
                        <Ionicons
                          name="trash-outline"
                          size={16}
                          color="#fff"
                        />
                        <Text
                          style={[
                            styles.actionText,
                            styles.actionDeleteText,
                          ]}
                        >
                          Delete
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              )}
            />
          )}
        </View>
      </View>

      <Modal
        visible={filtersVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setFiltersVisible(false)}
      >
        <View style={styles.promptOverlay}>
          <View style={styles.promptCard}>
            <Text style={styles.modalTitle}>Filters & Sort</Text>
            <View style={styles.modalDivider} />
            <Text style={styles.dropdownLabel}>Sort by</Text>
            <View style={styles.chipsRow}>
              <Chip
                label="Newest"
                active={sortMode === "newest"}
                onPress={() => setSortMode("newest")}
              />
              <Chip
                label="Oldest"
                active={sortMode === "oldest"}
                onPress={() => setSortMode("oldest")}
              />
              <Chip
                label="Name ↑"
                active={sortMode === "nameAsc"}
                onPress={() => setSortMode("nameAsc")}
              />
              <Chip
                label="Name ↓"
                active={sortMode === "nameDesc"}
                onPress={() => setSortMode("nameDesc")}
              />
              <Chip
                label="ID ↑"
                active={sortMode === "idAsc"}
                onPress={() => setSortMode("idAsc")}
              />
              <Chip
                label="ID ↓"
                active={sortMode === "idDesc"}
                onPress={() => setSortMode("idDesc")}
              />
            </View>

            <Text
              style={[styles.dropdownLabel, { marginTop: 10 }]}
            >
              Other
            </Text>
            <View style={styles.chipsRow}>
              <Chip
                label="Only non-zero"
                active={onlyNonZero}
                onPress={() => setOnlyNonZero((v) => !v)}
              />
              <Chip
                label="Has any rate"
                active={hasAnyRate}
                onPress={() => setHasAnyRate((v) => !v)}
              />
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.btnGhostAlt]}
                onPress={() => {
                  setSortMode("newest");
                  setOnlyNonZero(false);
                  setHasAnyRate(false);
                }}
              >
                <Text style={styles.btnGhostTextAlt}>Reset</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn]}
                onPress={() => setFiltersVisible(false)}
              >
                <Text style={styles.btnText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={createVisible}
        animationType="fade"
        transparent
        onRequestClose={() => setCreateVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.modalWrap}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>New Building</Text>
            <View style={styles.modalDivider} />
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingBottom: 8 }}
            >
              <View style={styles.inputRow}>
                <Text style={styles.inputLabel}>Name</Text>
                <TextInput
                  placeholder="e.g., BLDG-1"
                  value={c_name}
                  onChangeText={setC_name}
                  style={styles.input}
                  placeholderTextColor="#9aa5b1"
                />
              </View>

              <Text style={styles.sectionTitle}>Electric</Text>
              <View style={styles.grid3}>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Rate ₱/kWh</Text>
                  <TextInput
                    keyboardType="numeric"
                    value={c_eRate}
                    onChangeText={setC_eRate}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                  />
                </View>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Min kWh</Text>
                  <TextInput
                    keyboardType="numeric"
                    value={c_eMin}
                    onChangeText={setC_eMin}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                  />
                </View>
              </View>

              <Text style={styles.sectionTitle}>Water</Text>
              <View style={styles.grid3}>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Rate ₱/m³</Text>
                  <TextInput
                    keyboardType="numeric"
                    value={c_wRate}
                    onChangeText={setC_wRate}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                  />
                </View>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Min m³</Text>
                  <TextInput
                    keyboardType="numeric"
                    value={c_wMin}
                    onChangeText={setC_wMin}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                  />
                </View>
              </View>

              <Text style={styles.sectionTitle}>LPG, Markup & Penalty</Text>
              <View style={styles.grid3}>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>LPG ₱/kg</Text>
                  <TextInput
                    keyboardType="numeric"
                    value={c_lRate}
                    onChangeText={setC_lRate}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                  />
                </View>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Markup</Text>
                  <TextInput
                    keyboardType="numeric"
                    value={c_markup}
                    onChangeText={setC_markup}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                  />
                </View>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Penalty</Text>
                  <TextInput
                    keyboardType="numeric"
                    value={c_penalty}
                    onChangeText={setC_penalty}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                  />
                </View>
              </View>

              <Text style={styles.helpText}>
                Leave blank to save as{" "}
                <Text style={{ fontWeight: "700" }}>null</Text>.
              </Text>
            </ScrollView>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.btnGhostAlt]}
                onPress={() => setCreateVisible(false)}
              >
                <Text style={styles.btnGhostTextAlt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, submitting && styles.btnDisabled]}
                onPress={onCreate}
                disabled={submitting}
              >
                <Text style={styles.btnText}>
                  {submitting ? "Saving…" : "Create"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={editVisible}
        animationType="fade"
        transparent
        onRequestClose={() => setEditVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.modalWrap}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {editRow
                ? `Edit • ${editRow.building_name}`
                : "Edit Building"}
            </Text>
            <View style={styles.modalDivider} />
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingBottom: 8 }}
            >
              <View style={styles.inputRow}>
                <Text style={styles.inputLabel}>Name</Text>
                <TextInput
                  placeholder="e.g., BLDG-1"
                  value={e_name}
                  onChangeText={setE_name}
                  style={styles.input}
                  placeholderTextColor="#9aa5b1"
                />
              </View>

              <Text style={styles.sectionTitle}>Electric</Text>
              <View style={styles.grid3}>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Rate ₱/kWh</Text>
                  <TextInput
                    keyboardType="numeric"
                    value={e_eRate}
                    onChangeText={setE_eRate}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                  />
                </View>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Min kWh</Text>
                  <TextInput
                    keyboardType="numeric"
                    value={e_eMin}
                    onChangeText={setE_eMin}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                  />
                </View>
              </View>

              <Text style={styles.sectionTitle}>Water</Text>
              <View style={styles.grid3}>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Rate ₱/m³</Text>
                  <TextInput
                    keyboardType="numeric"
                    value={e_wRate}
                    onChangeText={setE_wRate}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                  />
                </View>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Min m³</Text>
                  <TextInput
                    keyboardType="numeric"
                    value={e_wMin}
                    onChangeText={setE_wMin}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                  />
                </View>
              </View>

              <Text style={styles.sectionTitle}>LPG, Markup & Penalty</Text>
              <View style={styles.grid3}>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>LPG ₱/kg</Text>
                  <TextInput
                    keyboardType="numeric"
                    value={e_lRate}
                    onChangeText={setE_lRate}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                  />
                </View>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Markup</Text>
                  <TextInput
                    keyboardType="numeric"
                    value={e_markup}
                    onChangeText={setE_markup}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                  />
                </View>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Penalty</Text>
                  <TextInput
                    keyboardType="numeric"
                    value={e_penalty}
                    onChangeText={setE_penalty}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                  />
                </View>
              </View>

              {editRow?.last_updated ? (
                <Text style={styles.helpText}>
                  Last updated: {fmtDate(editRow.last_updated)}{" "}
                  {editRow.updated_by
                    ? `• ${editRow.updated_by}`
                    : ""}
                </Text>
              ) : null}
            </ScrollView>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.btnGhostAlt]}
                onPress={() => setEditVisible(false)}
              >
                <Text style={styles.btnGhostTextAlt}>Close</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, submitting && styles.btnDisabled]}
                onPress={onUpdate}
                disabled={submitting}
              >
                <Text style={styles.btnText}>
                  {submitting ? "Saving…" : "Save"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    minHeight: 0,
  },
  grid: {
    flex: 1,
    padding: 14,
    gap: 14,
    minHeight: 0,
  },
  card: {
    flex: 1,
    minHeight: 0,
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 14,
    ...(Platform.select({
      web: {
        boxShadow: "0 10px 30px rgba(15, 23, 42, 0.08)",
      } as any,
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
  btn: {
    backgroundColor: "#2563eb",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  btnText: { color: "#fff", fontWeight: "700" },
  btnDisabled: { opacity: 0.6 },
  filtersBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
    flexWrap: "wrap",
  },
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
  search: {
    flex: 1,
    height: 40,
    color: "#0f172a",
  },
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
  loader: {
    paddingVertical: 24,
    alignItems: "center",
    justifyContent: "center",
  },
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
  rowMobile: {
    flexDirection: "column",
    alignItems: "stretch",
  },
  rowMain: { flex: 1, paddingRight: 10 },
  rowTitle: { fontSize: 16, fontWeight: "700", color: "#0f172a" },
  rowSub: { color: "#64748b", fontWeight: "600" },
  rowMeta: { color: "#334155", marginTop: 6 },
  rowMetaSmall: { color: "#94a3b8", marginTop: 2, fontSize: 12 },
  rowActions: {
    width: 200,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8,
  },
  rowActionsMobile: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
    justifyContent: "flex-start",
    alignItems: "center",
  },
  actionBtn: {
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  actionEdit: { backgroundColor: "#e2e8f0" },
  actionDelete: { backgroundColor: "#ef4444" },
  actionText: { fontWeight: "700" },
  actionEditText: { color: "#1f2937" },
  actionDeleteText: { color: "#fff" },
  emptyPad: { paddingVertical: 30 },
  empty: { alignItems: "center", gap: 6 },
  emptyTitle: { fontWeight: "800", color: "#0f172a" },
  emptyText: { color: "#94a3b8" },
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
      web: {
        boxShadow: "0 14px 44px rgba(15, 23, 42, 0.16)",
      } as any,
      default: { elevation: 3 },
    }) as any),
  },
  modalTitle: { fontSize: 18, fontWeight: "800", color: "#0f172a" },
  modalDivider: { height: 1, backgroundColor: "#e2e8f0", marginVertical: 10 },
  modalActions: {
    marginTop: 10,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
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
  sectionTitle: {
    marginTop: 10,
    marginBottom: 6,
    fontWeight: "800",
    color: "#0f172a",
  },
  helpText: {
    color: "#94a3b8",
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  grid3: {
    gap: 10,
    ...(Platform.OS === "web"
      ? ({
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          columnGap: 10,
          rowGap: 10,
        } as any)
      : {}),
  },
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
      web: {
        boxShadow: "0 14px 44px rgba(15, 23, 42, 0.16)",
      } as any,
      default: { elevation: 3 },
    }) as any),
  },
  dropdownLabel: { fontWeight: "800", color: "#0f172a", marginBottom: 8 },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
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
});