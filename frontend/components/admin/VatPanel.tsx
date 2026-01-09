import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import axios from "axios";
import { Ionicons } from "@expo/vector-icons";
import { BASE_API } from "../../constants/api";
import { useAuth } from "../../contexts/AuthContext";

export type VatCode = {
  tax_id: string;
  vat_code: string;
  vat_description: string | null;
  e_vat: number | null;
  w_vat: number | null;
  l_vat: number | null;
  last_updated?: string | null;
  updated_by?: string | null;
};

type SortMode =
  | "newest"
  | "oldest"
  | "codeAsc"
  | "codeDesc"
  | "eAsc"
  | "eDesc"
  | "wAsc"
  | "wDesc"
  | "lAsc"
  | "lDesc";

const fmtPct = (n: number | string | null | undefined) => {
  if (n == null || n === "") return "—";
  const v = typeof n === "string" ? Number(n) : n;
  if (!isFinite(Number(v))) return String(n);
  return Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(v));
};

const toNumOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const fmtDate = (iso?: string | null) => {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : String(iso);
};

const cmp = (a: string | number, b: string | number) =>
  String(a ?? "").localeCompare(String(b ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });

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

export default function VatPanel({ token }: { token: string | null }) {
  const { width } = useWindowDimensions();
  const isMobile = width < 640;

  const { hasRole } = useAuth();
  const isAdmin = hasRole("admin");
  const isBiller = hasRole("biller");
  const isOperator = hasRole("operator");
  const canEdit = isAdmin || isBiller;

  const [busy, setBusy] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [rows, setRows] = useState<VatCode[]>([]);
  const [query, setQuery] = useState("");
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [onlyNonZero, setOnlyNonZero] = useState(false);
  const [hasAnyRate, setHasAnyRate] = useState(false);

  const [c_code, setC_code] = useState("");
  const [c_desc, setC_desc] = useState("");
  const [c_e, setC_e] = useState("");
  const [c_w, setC_w] = useState("");
  const [c_l, setC_l] = useState("");

  const [editRow, setEditRow] = useState<VatCode | null>(null);
  const [e_code, setE_code] = useState("");
  const [e_desc, setE_desc] = useState("");
  const [e_e, setE_e] = useState("");
  const [e_w, setE_w] = useState("");
  const [e_l, setE_l] = useState("");

  const authHeader = useMemo(
    () => ({ Authorization: `Bearer ${token ?? ""}` }),
    [token]
  );
  const api = useMemo(
    () => axios.create({ baseURL: BASE_API, headers: authHeader, timeout: 15000 }),
    [authHeader]
  );
  const basePath = "/vat";

  useEffect(() => {
    loadAll();
  }, [token]);

  const loadAll = async () => {
    if (!token) {
      setBusy(false);
      notify("Not logged in", "Please log in to manage VAT codes.");
      return;
    }
    try {
      setBusy(true);
      const res = await api.get<VatCode[]>(basePath);
      setRows(res.data || []);
    } catch (err) {
      notify("Load failed", errorText(err, "Could not load VAT codes."));
    } finally {
      setBusy(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const nz = (v: number | null) =>
      v == null ? false : onlyNonZero ? Number(v) > 0 : true;
    let list = rows;
    if (hasAnyRate)
      list = list.filter(
        (r) => nz(r.e_vat) || nz(r.w_vat) || nz(r.l_vat)
      );
    if (q) {
      list = list.filter((r) =>
        [r.vat_code, r.vat_description, r.updated_by, r.tax_id]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      );
    }
    return list;
  }, [rows, query, onlyNonZero, hasAnyRate]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    switch (sortMode) {
      case "codeAsc":
        return arr.sort((a, b) => cmp(a.vat_code, b.vat_code));
      case "codeDesc":
        return arr.sort((a, b) => cmp(b.vat_code, a.vat_code));
      case "eAsc":
        return arr.sort(
          (a, b) => Number(a.e_vat ?? 0) - Number(b.e_vat ?? 0)
        );
      case "eDesc":
        return arr.sort(
          (a, b) => Number(b.e_vat ?? 0) - Number(a.e_vat ?? 0)
        );
      case "wAsc":
        return arr.sort(
          (a, b) => Number(a.w_vat ?? 0) - Number(b.w_vat ?? 0)
        );
      case "wDesc":
        return arr.sort(
          (a, b) => Number(b.w_vat ?? 0) - Number(a.w_vat ?? 0)
        );
      case "lAsc":
        return arr.sort(
          (a, b) => Number(a.l_vat ?? 0) - Number(b.l_vat ?? 0)
        );
      case "lDesc":
        return arr.sort(
          (a, b) => Number(b.l_vat ?? 0) - Number(a.l_vat ?? 0)
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
    if (!canEdit) return;
    const code = c_code.trim();
    if (!code) {
      notify("Missing info", "VAT Code is required.");
      return;
    }
    try {
      setSubmitting(true);
      await api.post(basePath, {
        vat_code: code,
        vat_description: c_desc.trim() || null,
        e_vat: toNumOrNull(c_e),
        w_vat: toNumOrNull(c_w),
        l_vat: toNumOrNull(c_l),
      });
      setC_code("");
      setC_desc("");
      setC_e("");
      setC_w("");
      setC_l("");
      setCreateVisible(false);
      await loadAll();
      notify("Success", "VAT code created.");
    } catch (err) {
      notify("Create failed", errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (r: VatCode) => {
    if (!canEdit) return;
    setEditRow(r);
    setE_code(r.vat_code ?? "");
    setE_desc(r.vat_description ?? "");
    setE_e(r.e_vat != null ? String(r.e_vat) : "");
    setE_w(r.w_vat != null ? String(r.w_vat) : "");
    setE_l(r.l_vat != null ? String(r.l_vat) : "");
    setEditVisible(true);
  };

  const onUpdate = async () => {
    if (!editRow || !canEdit) return;
    try {
      setSubmitting(true);
      await api.put(`${basePath}/${encodeURIComponent(String(editRow.tax_id))}`, {
        vat_code: e_code.trim(),
        vat_description: e_desc.trim() || null,
        e_vat: toNumOrNull(e_e),
        w_vat: toNumOrNull(e_w),
        l_vat: toNumOrNull(e_l),
      });
      setEditVisible(false);
      await loadAll();
      notify("Updated", "VAT code updated.");
    } catch (err) {
      notify("Update failed", errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (r: VatCode) => {
    if (!canEdit) return;
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (!window.confirm(`Delete VAT ${r.vat_code}?`)) return;
    }
    try {
      setSubmitting(true);
      await api.delete(`${basePath}/${encodeURIComponent(String(r.tax_id))}`);
      await loadAll();
      notify("Deleted", "VAT code removed.");
    } catch (err) {
      notify("Delete failed", errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const Row = ({ item }: { item: VatCode }) => (
    <View style={[styles.row, isMobile && styles.rowMobile]}>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>
          {item.vat_code} <Text style={styles.rowSub}>({item.tax_id})</Text>
        </Text>
        <Text style={styles.rowMeta}>{item.vat_description || "—"}</Text>
        <Text style={styles.rowMetaSmall}>
          ELECTRIC: {fmtPct(item.e_vat)} • WATER: {fmtPct(item.w_vat)} • LPG:{" "}
          {fmtPct(item.l_vat)}
          {item.last_updated ? `  •  updated ${fmtDate(item.last_updated)}` : ""}
          {item.updated_by ? `  •  by ${item.updated_by}` : ""}
        </Text>
      </View>
      {canEdit ? (
        isMobile ? (
          <View style={styles.rowActionsMobile}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.actionEdit]}
              onPress={() => openEdit(item)}
            >
              <Ionicons name="create-outline" size={16} color="#1f2937" />
              <Text style={[styles.actionText, styles.actionEditText]}>
                Update
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, styles.actionDelete]}
              onPress={() => onDelete(item)}
            >
              <Ionicons name="trash-outline" size={16} color="#fff" />
              <Text style={[styles.actionText, styles.actionDeleteText]}>
                Delete
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.rowActions}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.actionEdit]}
              onPress={() => openEdit(item)}
            >
              <Ionicons name="create-outline" size={16} color="#1f2937" />
              <Text style={[styles.actionText, styles.actionEditText]}>
                Update
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, styles.actionDelete]}
              onPress={() => onDelete(item)}
            >
              <Ionicons name="trash-outline" size={16} color="#fff" />
              <Text style={[styles.actionText, styles.actionDeleteText]}>
                Delete
              </Text>
            </TouchableOpacity>
          </View>
        )
      ) : null}
    </View>
  );

  return (
    <KeyboardAvoidingView
      behavior={Platform.select({ ios: "padding", android: undefined })}
      style={styles.page}
    >
      <View style={styles.grid}>
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>VAT Codes</Text>
            {canEdit && (
              <TouchableOpacity
                style={styles.btn}
                onPress={() => setCreateVisible(true)}
              >
                <Text style={styles.btnText}>+ New</Text>
              </TouchableOpacity>
            )}
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
                placeholder="Search by code, description, updated by, ID…"
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
              keyExtractor={(r) => r.tax_id}
              style={{ flex: 1 }}
              contentContainerStyle={
                sorted.length === 0 ? styles.emptyPad : { paddingBottom: 24 }
              }
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Ionicons
                    name="pricetag-outline"
                    size={42}
                    color="#cbd5e1"
                  />
                  <Text style={styles.emptyTitle}>No VAT codes found</Text>
                  <Text style={styles.emptySub}>
                    Try adjusting your search or create a new one.
                  </Text>
                </View>
              }
              renderItem={({ item }) => <Row item={item} />}
            />
          )}
        </View>
      </View>

      {filtersVisible && (
        <View style={styles.promptOverlay}>
          <View style={styles.promptCard}>
            <Text style={styles.modalTitle}>Filters & Sort</Text>
            <View style={styles.modalDivider} />
            <Text style={styles.dropdownLabel}>Sort by</Text>
            <View className="chipsRow" style={styles.chipsRow}>
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
                label="Code ↑"
                active={sortMode === "codeAsc"}
                onPress={() => setSortMode("codeAsc")}
              />
              <Chip
                label="Code ↓"
                active={sortMode === "codeDesc"}
                onPress={() => setSortMode("codeDesc")}
              />
              <Chip
                label="E ↑"
                active={sortMode === "eAsc"}
                onPress={() => setSortMode("eAsc")}
              />
              <Chip
                label="E ↓"
                active={sortMode === "eDesc"}
                onPress={() => setSortMode("eDesc")}
              />
              <Chip
                label="W ↑"
                active={sortMode === "wAsc"}
                onPress={() => setSortMode("wAsc")}
              />
              <Chip
                label="W ↓"
                active={sortMode === "wDesc"}
                onPress={() => setSortMode("wDesc")}
              />
              <Chip
                label="L ↑"
                active={sortMode === "lAsc"}
                onPress={() => setSortMode("lAsc")}
              />
              <Chip
                label="L ↓"
                active={sortMode === "lDesc"}
                onPress={() => setSortMode("lDesc")}
              />
            </View>
            <Text style={[styles.dropdownLabel, { marginTop: 10 }]}>
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
                  setFiltersVisible(false);
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
      )}

      {canEdit && createVisible && (
        <View style={styles.modalWrap}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Create VAT Code</Text>
            <View style={styles.modalDivider} />
            <View>
              <View style={styles.inputRow}>
                <Text style={styles.inputLabel}>VAT Code</Text>
                <TextInput
                  style={styles.input}
                  value={c_code}
                  onChangeText={setC_code}
                  placeholder="e.g., VAT12"
                  placeholderTextColor="#9aa5b1"
                  editable={canEdit}
                />
              </View>
              <View style={styles.inputRow}>
                <Text style={styles.inputLabel}>Description</Text>
                <TextInput
                  style={styles.input}
                  value={c_desc}
                  onChangeText={setC_desc}
                  placeholder="(optional)"
                  placeholderTextColor="#9aa5b1"
                  editable={canEdit}
                />
              </View>
              <Text style={styles.sectionTitle}>Rates (%)</Text>
              <View style={styles.grid3}>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>E-VAT</Text>
                  <TextInput
                    style={styles.input}
                    keyboardType="numeric"
                    value={c_e}
                    onChangeText={setC_e}
                    placeholder="e.g., 12"
                    placeholderTextColor="#9aa5b1"
                    editable={canEdit}
                  />
                </View>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>W-VAT</Text>
                  <TextInput
                    style={styles.input}
                    keyboardType="numeric"
                    value={c_w}
                    onChangeText={setC_w}
                    placeholder="e.g., 0"
                    placeholderTextColor="#9aa5b1"
                    editable={canEdit}
                  />
                </View>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>L-VAT</Text>
                  <TextInput
                    style={styles.input}
                    keyboardType="numeric"
                    value={c_l}
                    onChangeText={setC_l}
                    placeholder="e.g., 0"
                    placeholderTextColor="#9aa5b1"
                    editable={canEdit}
                  />
                </View>
              </View>
              <Text style={styles.helpText}>
                Leave blank to save as{" "}
                <Text style={{ fontWeight: "700" }}>null</Text>.
              </Text>
            </View>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.btnGhostAlt]}
                onPress={() => setCreateVisible(false)}
              >
                <Text style={styles.btnGhostTextAlt}>Cancel</Text>
              </TouchableOpacity>
              {canEdit && (
                <TouchableOpacity
                  style={[styles.btn, submitting && styles.btnDisabled]}
                  onPress={onCreate}
                  disabled={submitting}
                >
                  <Text style={styles.btnText}>
                    {submitting ? "Saving…" : "Create"}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      )}

      {canEdit && editVisible && (
        <View style={styles.modalWrap}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {editRow ? `Edit • ${editRow.vat_code}` : "Edit VAT Code"}
            </Text>
            <View style={styles.modalDivider} />
            <View>
              <View style={styles.inputRow}>
                <Text style={styles.inputLabel}>VAT Code</Text>
                <TextInput
                  style={styles.input}
                  value={e_code}
                  onChangeText={setE_code}
                  placeholder="e.g., VAT12"
                  placeholderTextColor="#9aa5b1"
                  editable={canEdit}
                />
              </View>
              <View style={styles.inputRow}>
                <Text style={styles.inputLabel}>Description</Text>
                <TextInput
                  style={styles.input}
                  value={e_desc}
                  onChangeText={setE_desc}
                  placeholder="(optional)"
                  placeholderTextColor="#9aa5b1"
                  editable={canEdit}
                />
              </View>
              <Text style={styles.sectionTitle}>Rates (%)</Text>
              <View style={styles.grid3}>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>E-VAT</Text>
                  <TextInput
                    style={styles.input}
                    keyboardType="numeric"
                    value={e_e}
                    onChangeText={setE_e}
                    placeholder="e.g., 12"
                    placeholderTextColor="#9aa5b1"
                    editable={canEdit}
                  />
                </View>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>W-VAT</Text>
                  <TextInput
                    style={styles.input}
                    keyboardType="numeric"
                    value={e_w}
                    onChangeText={setE_w}
                    placeholder="e.g., 0"
                    placeholderTextColor="#9aa5b1"
                    editable={canEdit}
                  />
                </View>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>L-VAT</Text>
                  <TextInput
                    style={styles.input}
                    keyboardType="numeric"
                    value={e_l}
                    onChangeText={setE_l}
                    placeholder="e.g., 0"
                    placeholderTextColor="#9aa5b1"
                    editable={canEdit}
                  />
                </View>
              </View>
              {editRow?.last_updated ? (
                <Text style={styles.helpText}>
                  Last updated: {fmtDate(editRow.last_updated)}{" "}
                  {editRow.updated_by ? `• ${editRow.updated_by}` : ""}
                </Text>
              ) : null}
            </View>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.btnGhostAlt]}
                onPress={() => setEditVisible(false)}
              >
                <Text style={styles.btnGhostTextAlt}>Close</Text>
              </TouchableOpacity>
              {canEdit && (
                <TouchableOpacity
                  style={[styles.btn, submitting && styles.btnDisabled]}
                  onPress={onUpdate}
                  disabled={submitting}
                >
                  <Text style={styles.btnText}>
                    {submitting ? "Saving…" : "Save"}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
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
  cardTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#0f172a",
  },
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
    backgroundColor: "#f1f59",
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
  loader: { paddingVertical: 24, alignItems: "center", justifyContent: "center" },
  row: {
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 12,
    padding: 12,
    backgroundColor: "#ffffff",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 10,
  },
  rowMobile: {
    flexDirection: "column",
    alignItems: "stretch",
  },
  rowMain: {
    flex: 1,
    paddingRight: 6,
  },
  rowTitle: { fontSize: 15, fontWeight: "800", color: "#0f172a" },
  rowSub: { color: "#64748b", fontWeight: "600" },
  rowMeta: { color: "#334155", marginTop: 2 },
  rowMetaSmall: { color: "#94a3b8", marginTop: 2, fontSize: 12 },
  rowActions: {
    width: 200,
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 8,
  },
  rowActionsMobile: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
    alignItems: "center",
    justifyContent: "flex-start",
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
  empty: {
    paddingVertical: 24,
    gap: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: { fontSize: 16, fontWeight: "800", color: "#0f172a" },
  emptySub: { color: "#94a3b8", textAlign: "center" },
  promptOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
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
  sectionTitle: { marginTop: 10, marginBottom: 6, fontWeight: "800", color: "#0f172a" },
  helpText: { color: "#94a3b8", fontSize: 12, lineHeight: 16, marginTop: 2 },
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
  dropdownLabel: { fontWeight: "800", color: "#0f172a", marginBottom: 8 },
  modalWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
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
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 4 },
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