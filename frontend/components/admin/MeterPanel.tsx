import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { Picker } from "@react-native-picker/picker";
import QRCode from "react-native-qrcode-svg";
import { Ionicons } from "@expo/vector-icons";
import { BASE_API } from "../../constants/api";
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
function confirm(title: string, message: string): Promise<boolean> {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return Promise.resolve(!!(window as any).confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: "Delete", style: "destructive", onPress: () => resolve(true) },
    ]);
  });
}
export type Meter = {
  meter_id: string;
  meter_type: "electric" | "water" | "lpg";
  meter_sn: string;
  meter_mult: number;
  stall_id: string;
  meter_status: "active" | "inactive";
  last_updated?: string;
  updated_by?: string;
};
export type Stall = { stall_id: string; stall_sn: string; building_id?: string };
type Building = { building_id: string; building_name: string };
function decodeJwtPayload(token: string | null): any | null {
  if (!token) return null;
  try {
    const part = token.split(".")[1] || "";
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (base64.length % 4)) % 4;
    const padded = base64 + "=".repeat(padLen);
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    let str = "";
    for (let i = 0; i < padded.length; i += 4) {
      const c1 = chars.indexOf(padded[i]);
      const c2 = chars.indexOf(padded[i + 1]);
      const c3 = chars.indexOf(padded[i + 2]);
      const c4 = chars.indexOf(padded[i + 3]);
      const n = (c1 << 18) | (c2 << 12) | ((c3 & 63) << 6) | (c4 & 63);
      const b1 = (n >> 16) & 255, b2 = (n >> 8) & 255, b3 = n & 255;
      if (c3 === 64) str += String.fromCharCode(b1);
      else if (c4 === 64) str += String.fromCharCode(b1, b2);
      else str += String.fromCharCode(b1, b2, b3);
    }
    const json = decodeURIComponent(
      str.split("").map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join("")
    );
    return JSON.parse(json);
  } catch { return null; }
}
export default function MeterPanel({ token }: { token: string | null }) {
  const jwt = useMemo(() => decodeJwtPayload(token), [token]);
  const isAdmin = String(jwt?.user_level || "").toLowerCase() === "admin";
  const userBuildingId = String(jwt?.building_id || "");
  const { width } = useWindowDimensions();
  const isMobile = width < 640;
  const [busy, setBusy] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [meters, setMeters] = useState<Meter[]>([]);
  const [stalls, setStalls] = useState<Stall[]>([]);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [query, setQuery] = useState("");
  const [filterType, setFilterType] = useState<"all" | "electric" | "water" | "lpg">("all");
  const [buildingFilter, setBuildingFilter] = useState<string>("");
  type SortMode = "id_asc" | "id_desc" | "type" | "stall" | "status";
  const [sortBy, setSortBy] = useState<SortMode>("id_asc");
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [qrVisible, setQrVisible] = useState(false);
  const [type, setType] = useState<Meter["meter_type"]>("electric");
  const [sn, setSn] = useState("");
  const [mult, setMult] = useState("");
  const [stallId, setStallId] = useState("");
  const [status, setStatus] = useState<Meter["meter_status"]>("inactive");
  const [editRow, setEditRow] = useState<Meter | null>(null);
  const [editType, setEditType] = useState<Meter["meter_type"]>("electric");
  const [editSn, setEditSn] = useState("");
  const [editMult, setEditMult] = useState("");
  const [editStallId, setEditStallId] = useState("");
  const [editStatus, setEditStatus] = useState<Meter["meter_status"]>("inactive");
  const [qrMeterId, setQrMeterId] = useState("");
  const qrCodeRef = useRef<any>(null);
  const authHeader = useMemo(() => ({ Authorization: `Bearer ${token ?? ""}` }), [token]);
  const api = useMemo(() => axios.create({ baseURL: BASE_API, headers: authHeader, timeout: 15000 }), [authHeader]);
  useEffect(() => { loadAll(); }, [token]);
  const loadAll = async () => {
    if (!token) { setBusy(false); notify("Not logged in", "Please log in to manage meters."); return; }
    try {
      setBusy(true);
      const [metersRes, stallsRes] = await Promise.all([
        api.get<Meter[]>("/meters"),
        api.get<Stall[]>("/stalls"),
      ]);
      setMeters(metersRes.data || []);
      setStalls(stallsRes.data || []);
      if (isAdmin) {
        try { const bRes = await api.get<Building[]>("/buildings"); setBuildings(bRes.data || []); } catch { setBuildings([]); }
      } else { setBuildings([]); }
      if (!isAdmin && userBuildingId) setBuildingFilter((prev) => prev || userBuildingId);
    } catch (err: any) {
      notify("Load failed", errorText(err, "Could not load meters/stalls."));
    } finally { setBusy(false); }
  };
  const mtrNum = (id: string) => { const m = /^MTR-(\d+)/i.exec(id || ""); return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER; };
  const stallToBuilding = useMemo(() => {
    const m = new Map<string, string>();
    stalls.forEach((s) => { if (s?.stall_id && s?.building_id) m.set(s.stall_id, s.building_id); });
    return m;
  }, [stalls]);
  const buildingChipOptions = useMemo(() => {
    if (isAdmin && buildings.length) {
      return [{ label: "All", value: "" }].concat(
        buildings
          .slice()
          .sort((a, b) => a.building_name.localeCompare(b.building_name))
          .map((b) => ({ label: b.building_name || b.building_id, value: b.building_id }))
      );
    }
    const ids = new Set<string>();
    stalls.forEach((s) => s?.building_id && ids.add(s.building_id));
    const arr = Array.from(ids);
    const base = [{ label: "All", value: "" }];
    if (userBuildingId) return base.concat([{ label: userBuildingId, value: userBuildingId }]);
    if (arr.length) return base.concat(arr.sort().map((id) => ({ label: id, value: id })));
    return base;
  }, [isAdmin, buildings, stalls, userBuildingId]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = meters;
    if (filterType !== "all") list = list.filter((m) => m.meter_type === filterType);
    if (buildingFilter) list = list.filter((m) => stallToBuilding.get(m.stall_id) === buildingFilter);
    if (!q) return list;
    return list.filter((m) => [m.meter_id, m.meter_sn, m.meter_type, m.stall_id, m.meter_status].some((v) => String(v).toLowerCase().includes(q)));
  }, [meters, query, filterType, buildingFilter, stallToBuilding]);
  const sorted = useMemo(() => {
    const arr = [...filtered];
    switch (sortBy) {
      case "id_desc": return arr.sort((a, b) => mtrNum(b.meter_id) - mtrNum(a.meter_id) || b.meter_id.localeCompare(a.meter_id));
      case "type":    return arr.sort((a, b) => a.meter_type.localeCompare(b.meter_type) || mtrNum(a.meter_id) - mtrNum(b.meter_id));
      case "stall":   return arr.sort((a, b) => (a.stall_id || "").localeCompare(b.stall_id || "") || mtrNum(a.meter_id) - mtrNum(b.meter_id));
      case "status":  return arr.sort((a, b) => (a.meter_status === "active" ? 0 : 1) - (b.meter_status === "active" ? 0 : 1) || mtrNum(a.meter_id) - mtrNum(b.meter_id));
      case "id_asc":
      default:         return arr.sort((a, b) => mtrNum(a.meter_id) - mtrNum(b.meter_id) || a.meter_id.localeCompare(b.meter_id));
    }
  }, [filtered, sortBy]);
  const onCreate = async () => {
    if (!sn.trim() || !stallId.trim()) { notify("Missing info", "Serial number and Stall are required."); return; }
    const payload: any = {
      meter_type: type,
      meter_sn: sn.trim(),
      stall_id: stallId.trim(),
      meter_status: status,
    };
    if (mult.trim() !== "") {
      const asNum = Number(mult);
      if (!Number.isFinite(asNum)) { notify("Invalid multiplier", "Enter a numeric multiplier (e.g., 1 or 93). "); return; }
      payload.meter_mult = asNum;
    }
    try {
      setSubmitting(true);
      await api.post("/meters", payload);
      notify("Success", "Meter created.");
      setSn(""); setMult(""); setStallId(""); setStatus("inactive"); setType("electric");
      setCreateVisible(false);
      await loadAll();
    } catch (err: any) {
      const msg = errorText(err);
      if (/meter_sn already exists/i.test(msg)) notify("Duplicate serial", "That meter SN is already used.");
      else notify("Create failed", msg);
    } finally { setSubmitting(false); }
  };
  const openEdit = (m: Meter) => {
    setEditRow(m);
    setEditType(m.meter_type);
    setEditSn(m.meter_sn);
    setEditMult("");
    setEditStallId(m.stall_id);
    setEditStatus(m.meter_status);
    setEditVisible(true);
  };
  const onUpdate = async () => {
    if (!editRow) return;
    const body: any = {
      meter_type: editType,
      meter_sn: editSn.trim(),
      stall_id: editStallId.trim(),
      meter_status: editStatus,
    };
    if (editMult.trim() !== "") {
      const asNum = Number(editMult);
      if (!Number.isFinite(asNum)) { notify("Invalid multiplier", "Enter a numeric multiplier (e.g., 1 or 93). "); return; }
      body.meter_mult = asNum;
    }
    try {
      setSubmitting(true);
      await api.put(`/meters/${encodeURIComponent(editRow.meter_id)}`, body);
      setEditVisible(false);
      await loadAll();
      notify("Updated", "Meter updated successfully.");
    } catch (err: any) {
      const msg = errorText(err);
      if (/meter_sn already exists/i.test(msg)) notify("Duplicate serial", "That meter SN is already used.");
      else notify("Update failed", msg);
    } finally { setSubmitting(false); }
  };
  const onDelete = async (m: Meter) => {
    const ok = await confirm("Delete meter", `Are you sure you want to delete ${m.meter_id}?`);
    if (!ok) return;
    try {
      setSubmitting(true);
      await api.delete(`/meters/${encodeURIComponent(m.meter_id)}`);
      await loadAll();
      notify("Deleted", "Meter removed.");
    } catch (err: any) {
      const msg = errorText(err);
      if (/referenced by: Reading/i.test(msg)) notify("Cannot delete", msg);
      else notify("Delete failed", msg);
    } finally { setSubmitting(false); }
  };
  const openQr = (meter_id: string) => { setQrMeterId(meter_id); setQrVisible(true); };
  const downloadQr = () => {
    if (!qrCodeRef.current) return;
    try {
      qrCodeRef.current.toDataURL((data: string) => {
        const dataUrl = `data:image/png;base64,${data}`;
        if (Platform.OS === "web" && typeof document !== "undefined") {
          const a = document.createElement("a");
          a.href = dataUrl;
          a.download = `${qrMeterId || "meter-qr"}.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
        } else {
          notify("Save QR", "On mobile, please take a screenshot of this QR.");
        }
      });
    } catch {
      notify("Download failed", "Could not generate QR image.");
    }
  };
  const printQr = () => {
    if (!qrCodeRef.current) {
      notify("Print QR", "QR code is not ready yet.");
      return;
    }

    try {
      qrCodeRef.current.toDataURL((data: string) => {
        const dataUrl = `data:image/png;base64,${data}`;

        if (Platform.OS === "web" && typeof window !== "undefined") {
          const printWindow = window.open("", "_blank");
          if (!printWindow) {
            notify("Print QR", "Pop-up blocked. Please allow pop-ups and try again.");
            return;
          }

          printWindow.document.write(`
            <!DOCTYPE html>
            <html>
              <head>
                <meta charset="utf-8" />
                <title>Meter QR - ${qrMeterId}</title>
                <style>
                  body {
                    margin: 0;
                    padding: 0;
                    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                    background: #ffffff;
                  }
                  .wrap {
                    text-align: center;
                  }
                  img {
                    width: 60px;
                    height: 60px;
                  }
                  h1 {
                    font-size: 18px;
                    margin-bottom: 8px;
                  }
                  p {
                    font-size: 14px;
                    color: #6b7280;
                  }
                  @media print {
                    body { margin: 0; }
                  }
                </style>
              </head>
              <body>
                <div class="wrap">
                  <p>${qrMeterId || ""}</p>
                  <img src="${dataUrl}" alt="Meter QR" />
                </div>
                <script>
                  setTimeout(function () {
                    window.print();
                  }, 500);
                </script>
              </body>
            </html>
          `);
          printWindow.document.close();
        } else {
          notify("Print QR", "Direct printing is only available on web. On mobile, please download or screenshot the QR.");
        }
      });
    } catch (e) {
      notify("Print failed", "Could not generate QR image for printing.");
    }
  };

  if (busy) {
    return (
      <View style={[styles.screen, { justifyContent: "center", alignItems: "center" }]}>
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Meters</Text>
          <TouchableOpacity style={styles.btn} onPress={() => setCreateVisible(true)}>
            <Text style={styles.btnText}>+ Create Meter</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.filtersBar}>
          <View style={[styles.searchWrap, { flex: 1 }]}> 
            <Ionicons name="search" size={16} color="#94a3b8" style={{ marginRight: 6 }} />
            <TextInput
              placeholder="Search by ID, SN, type, stall…"
              placeholderTextColor="#9aa5b1"
              value={query}
              onChangeText={setQuery}
              style={styles.search}
              returnKeyType="search"
            />
          </View>
          <TouchableOpacity style={styles.btnGhost} onPress={() => setFiltersVisible(true)}>
            <Ionicons name="options-outline" size={16} color="#394e6a" style={{ marginRight: 6 }} />
            <Text style={styles.btnGhostText}>Filters</Text>
          </TouchableOpacity>
        </View>
        <View style={{ marginTop: 6, marginBottom: 12 }}>
          <View style={styles.buildingHeaderRow}>
            <Text style={styles.dropdownLabel}>Building</Text>
          </View>
          {isMobile ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRowHorizontal}>
              {buildingChipOptions.map((opt) => (
                <Chip key={opt.value || "all"} label={opt.label} active={buildingFilter === opt.value} onPress={() => setBuildingFilter(opt.value)} />
              ))}
            </ScrollView>
          ) : (
            <View style={styles.chipsRow}>
              {buildingChipOptions.map((opt) => (
                <Chip key={opt.value || "all"} label={opt.label} active={buildingFilter === opt.value} onPress={() => setBuildingFilter(opt.value)} />
              ))}
            </View>
          )}
        </View>
        {sorted.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Ionicons name="archive-outline" size={22} color="#94a3b8" />
            <Text style={styles.empty}>No meters found.</Text>
          </View>
        ) : (
          <FlatList
            data={sorted}
            keyExtractor={(item) => item.meter_id}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 16 }}
            renderItem={({ item }) => (
              <View style={[styles.row, isMobile && styles.rowMobile]}>
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle}>
                    {item.meter_id} <Text style={styles.rowSub}>• {item.meter_type.toUpperCase()}</Text>
                  </Text>
                  <Text style={styles.rowMeta}>
                    SN: {item.meter_sn} · Mult: {item.meter_mult} · Stall: {item.stall_id}
                  </Text>
                  <Text style={styles.rowMetaSmall}>Status: {item.meter_status.toUpperCase()}</Text>
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
                    <TouchableOpacity style={[styles.actionBtn, styles.actionGhost]} onPress={() => openQr(item.meter_id)}>
                      <Ionicons name="qr-code-outline" size={16} color="#1d4ed8" />
                      <Text style={[styles.actionText, styles.actionGhostText]}>QR</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View style={styles.rowActions}>
                    <TouchableOpacity style={[styles.actionBtn, styles.actionGhost]} onPress={() => openQr(item.meter_id)}>
                      <Ionicons name="qr-code-outline" size={16} color="#1d4ed8" />
                      <Text style={[styles.actionText, styles.actionGhostText]}>QR</Text>
                    </TouchableOpacity>
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
      <Modal visible={filtersVisible} animationType="fade" transparent onRequestClose={() => setFiltersVisible(false)}>
        <View style={styles.promptOverlay}>
          <View style={styles.promptCard}>
            <Text style={styles.modalTitle}>Filters & Sort</Text>
            <View style={styles.modalDivider} />
            <Text style={[styles.dropdownLabel, { marginTop: 4 }]}>Type</Text>
            <View style={styles.chipsRow}>
              {["all", "electric", "water", "lpg"].map((t) => (
                <Chip key={t} label={t.toUpperCase()} active={filterType === (t as any)} onPress={() => setFilterType(t as any)} />
              ))}
            </View>
            <Text style={[styles.dropdownLabel, { marginTop: 12 }]}>Sort by</Text>
            <View style={styles.chipsRow}>
              {[
                { label: "ID ↑", val: "id_asc" },
                { label: "ID ↓", val: "id_desc" },
                { label: "Type", val: "type" },
                { label: "Stall", val: "stall" },
                { label: "Status", val: "status" },
              ].map(({ label, val }) => (
                <Chip key={val} label={label} active={sortBy === (val as SortMode)} onPress={() => setSortBy(val as SortMode)} />
              ))}
            </View>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.btn, styles.btnGhost]}
                onPress={() => {
                  setQuery(""); setBuildingFilter(isAdmin ? "" : userBuildingId || "");
                  setFilterType("all"); setSortBy("id_asc"); setFiltersVisible(false);
                }}
              >
                <Text style={styles.btnGhostText}>Reset</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btn} onPress={() => setFiltersVisible(false)}>
                <Text style={styles.btnText}>Apply</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      <Modal visible={createVisible} animationType="slide" transparent onRequestClose={() => setCreateVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalWrap}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Create Meter</Text>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
              <Text style={styles.dropdownLabel}>Type</Text>
              <View style={styles.pickerWrapper}>
                <Picker selectedValue={type} onValueChange={(v) => setType(v)} style={styles.picker}>
                  <Picker.Item label="Electric" value="electric" />
                  <Picker.Item label="Water" value="water" />
                  <Picker.Item label="LPG (Gas)" value="lpg" />
                </Picker>
              </View>
              <Text style={styles.dropdownLabel}>Serial Number</Text>
              <TextInput value={sn} onChangeText={setSn} placeholder="e.g. UGF-E-000111" style={styles.input} />
              <Text style={styles.dropdownLabel}>Multiplier <Text style={{ color: "#64748b", fontWeight: "400" }}>(leave blank to auto)</Text></Text>
              <TextInput value={mult} onChangeText={setMult} keyboardType="numeric" placeholder="e.g. 1 or 93" style={styles.input} />
              <Text style={styles.help}>Water defaults to 93.00; Electric/LPG default to 1.00 when left blank.</Text>
              <Text style={styles.dropdownLabel}>Stall</Text>
              <View style={styles.pickerWrapper}>
                <Picker selectedValue={stallId} onValueChange={(v) => setStallId(v)} style={styles.picker}>
                  <Picker.Item label="Select a stall" value="" />
                  {stalls.map((s) => (
                    <Picker.Item key={s.stall_id} label={`${s.stall_id} • ${s.stall_sn || ""}`} value={s.stall_id} />
                  ))}
                </Picker>
              </View>
              <Text style={styles.dropdownLabel}>Status</Text>
              <View style={styles.pickerWrapper}>
                <Picker selectedValue={status} onValueChange={(v) => setStatus(v)} style={styles.picker}>
                  <Picker.Item label="Inactive" value="inactive" />
                  <Picker.Item label="Active" value="active" />
                </Picker>
              </View>
            </ScrollView>
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => setCreateVisible(false)}>
                <Text style={styles.btnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, submitting && styles.btnDisabled]} onPress={onCreate} disabled={submitting}>
                {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Create Meter</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <Modal visible={editVisible} animationType="slide" transparent onRequestClose={() => setEditVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalWrap}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Update {editRow?.meter_id}</Text>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
              <Text style={styles.dropdownLabel}>Type</Text>
              <View style={styles.pickerWrapper}>
                <Picker selectedValue={editType} onValueChange={(v) => setEditType(v)} style={styles.picker}>
                  <Picker.Item label="Electric" value="electric" />
                  <Picker.Item label="Water" value="water" />
                  <Picker.Item label="LPG (Gas)" value="lpg" />
                </Picker>
              </View>
              <Text style={styles.dropdownLabel}>Serial Number</Text>
              <TextInput value={editSn} onChangeText={setEditSn} style={styles.input} />
              <Text style={styles.dropdownLabel}>Multiplier <Text style={{ color: "#64748b", fontWeight: "400" }}>(leave blank to keep or auto if type changed)</Text></Text>
              <TextInput value={editMult} onChangeText={setEditMult} keyboardType="numeric" style={styles.input} />
              <Text style={styles.dropdownLabel}>Stall</Text>
              <View style={styles.pickerWrapper}>
                <Picker selectedValue={editStallId} onValueChange={(v) => setEditStallId(v)} style={styles.picker}>
                  {stalls.map((s) => (
                    <Picker.Item key={s.stall_id} label={`${s.stall_id} • ${s.stall_sn || ""}`} value={s.stall_id} />
                  ))}
                </Picker>
              </View>
              <Text style={styles.dropdownLabel}>Status</Text>
              <View style={styles.pickerWrapper}>
                <Picker selectedValue={editStatus} onValueChange={(v) => setEditStatus(v)} style={styles.picker}>
                  <Picker.Item label="Inactive" value="inactive" />
                  <Picker.Item label="Active" value="active" />
                </Picker>
              </View>
            </ScrollView>
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => setEditVisible(false)}>
                <Text style={styles.btnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, submitting && styles.btnDisabled]} onPress={onUpdate} disabled={submitting}>
                {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Save changes</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <Modal visible={qrVisible} animationType="fade" transparent onRequestClose={() => setQrVisible(false)}>
        <View style={styles.modalWrap}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>QR: {qrMeterId}</Text>
            <View style={{ alignItems: "center", paddingVertical: 8 }}>
              <QRCode value={qrMeterId || ""} size={220} getRef={(c) => (qrCodeRef.current = c)} />
            </View>
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => setQrVisible(false)}>
                <Text style={styles.btnGhostText}>Close</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btn} onPress={printQr}>
                <Text style={styles.btnText}>Print</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btn} onPress={downloadQr}>
                <Text style={styles.btnText}>Download</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress?: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.chip, active ? styles.chipActive : styles.chipIdle]}>
      <Text style={[styles.chipText, active ? styles.chipTextActive : styles.chipTextIdle]}>{label}</Text>
    </TouchableOpacity>
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
    ...(Platform.select({ web: { boxShadow: "0 10px 30px rgba(2,6,23,0.06)" as any }, default: { elevation: 3 } }) as any),
  },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  cardTitle: { fontSize: 18, fontWeight: "900", color: "#0f172a" },
  btn: { backgroundColor: "#2563eb", paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10 },
  btnText: { color: "#fff", fontWeight: "700" },
  btnDisabled: { opacity: 0.6 },
  filtersBar: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" },
  searchWrap: { flexDirection: "row", alignItems: "center", backgroundColor: "#f1f5f9", borderRadius: 10, paddingHorizontal: 10, height: 40, borderWidth: 1, borderColor: "#e2e8f0" },
  search: { flex: 1, height: 40, color: "#0f172a" },
  btnGhost: { flexDirection: "row", alignItems: "center", backgroundColor: "#e2e8f0", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: "#cbd5e1" },
  btnGhostText: { color: "#394e6a", fontWeight: "700" },
  buildingHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chipsRowHorizontal: { paddingRight: 4, gap: 8, alignItems: "center" },
  chip: { borderWidth: 1, borderColor: "#cbd5e1", backgroundColor: "#f8fafc", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  chipActive: { backgroundColor: "#e0ecff", borderColor: "#93c5fd" },
  chipIdle: {},
  chipText: { fontWeight: "700" },
  chipTextActive: { color: "#1d4ed8" },
  chipTextIdle: { color: "#334155" },
  row: { borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 12, padding: 12, marginBottom: 10, backgroundColor: "#fff", flexDirection: "row", alignItems: "center" },
  rowMobile: { flexDirection: "column", alignItems: "stretch" },
  rowMain: { flex: 1, paddingRight: 10 },
  rowTitle: { fontSize: 16, fontWeight: "700", color: "#0f172a" },
  rowSub: { color: "#64748b", fontWeight: "600" },
  rowMeta: { color: "#334155", marginTop: 6 },
  rowMetaSmall: { color: "#94a3b8", marginTop: 2, fontSize: 12 },
  rowActions: { width: 260, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8 },
  rowActionsMobile: { flexDirection: "row", gap: 8, marginTop: 10, justifyContent: "flex-start", alignItems: "center" },
  actionBtn: { height: 36, paddingHorizontal: 12, borderRadius: 10, flexDirection: "row", alignItems: "center", gap: 6 },
  actionEdit: { backgroundColor: "#e2e8f0" },
  actionDelete: { backgroundColor: "#ef4444" },
  actionGhost: { backgroundColor: "#e0ecff" },
  actionText: { fontWeight: "700" },
  actionEditText: { color: "#1f2937" },
  actionDeleteText: { color: "#fff" },
  actionGhostText: { color: "#1d4ed8" },
  emptyWrap: { alignItems: "center", paddingVertical: 24, gap: 6 },
  empty: { color: "#64748b" },
  dropdownLabel: { fontWeight: "800", color: "#0f172a", marginBottom: 8, textTransform: "none" },
  pickerWrapper: { borderWidth: 1, borderColor: "#dbe2ea", borderRadius: 8, overflow: "hidden" },
  picker: { height: 40 },
  input: { backgroundColor: "#f8fafc", borderWidth: 1, borderColor: "#e7ecf3", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, color: "#0f172a" },
  help: { color: "#64748b", fontSize: 12, marginTop: 4, marginBottom: 8 },
  modalWrap: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", alignItems: "center", justifyContent: "center", padding: 12 },
  modalCard: { backgroundColor: "#fff", borderRadius: 16, padding: 14, borderWidth: 1, borderColor: "#eef2f7", ...(Platform.select({ web: { boxShadow: "0 14px 36px rgba(2,6,23,0.25)" as any }, default: { elevation: 4 } }) as any), width: "100%", maxWidth: 560 },
  modalTitle: { fontSize: 16, fontWeight: "900", color: "#0b2447" },
  modalDivider: { height: 1, backgroundColor: "#e5e7eb", marginVertical: 10 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 12 },
  promptOverlay: { flex: 1, backgroundColor: "rgba(16,42,67,0.25)", justifyContent: "center", alignItems: "center", padding: 16 },
  promptCard: { backgroundColor: "#fff", width: "100%", maxWidth: 520, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: "#eef2f7", ...(Platform.select({ web: { boxShadow: "0 8px 24px rgba(16,42,67,0.08)" as any }, default: { elevation: 3 } }) as any) },
});