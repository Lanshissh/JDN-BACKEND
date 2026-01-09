import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import axios from "axios";
import { Ionicons } from "@expo/vector-icons";

import { BASE_API } from "../../constants/api";
import { useAuth } from "../../contexts/AuthContext";
import { Card, Button } from "../ui/ProUI";

type ReaderDevice = {
  device_id: number;
  device_serial: string;
  device_name: string;
  device_token: string;
  status: "active" | "blocked";
  device_info?: string | null;
  created_at?: string;
  last_used_at?: string | null;
};

export default function ReaderDevicesPanel() {
  const { token, hasRole } = useAuth();
  const isAdmin = hasRole("admin");

  const [devices, setDevices] = useState<ReaderDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [serial, setSerial] = useState("");
  const [name, setName] = useState("");
  const [info, setInfo] = useState("");
  const [query, setQuery] = useState("");

  const authHeader = useMemo(() => {
    const raw = String(token || "").trim();
    if (!raw) return {};
    return {
      Authorization: /^Bearer\s/i.test(raw) ? raw : `Bearer ${raw}`,
    };
  }, [token]);

  const api = useMemo(
    () =>
      axios.create({
        baseURL: BASE_API,
        timeout: 20000,
        headers: authHeader,
      }),
    [authHeader]
  );

  const loadDevices = useCallback(async () => {
    if (!token || !isAdmin) return;
    try {
      setLoading(true);
      setError(null);

      const res = await api.get("/reader-devices", {
        validateStatus: () => true,
      });

      if (res.status !== 200 || !Array.isArray(res.data)) {
        setError(`Failed to load devices (${res.status})`);
        setDevices([]);
        return;
      }

      setDevices(res.data);
    } catch (err: any) {
      setError(err?.message || "Failed to load devices");
      setDevices([]);
    } finally {
      setLoading(false);
    }
  }, [api, token, isAdmin]);

  useEffect(() => {
    if (isAdmin) loadDevices();
  }, [isAdmin, loadDevices]);

  const createDevice = async () => {
    if (!serial.trim() || !name.trim()) return;

    try {
      setLoading(true);
      await api.post("/reader-devices", {
        device_serial: serial.trim(),
        device_name: name.trim(),
        device_info: info.trim() || null,
      });

      setSerial("");
      setName("");
      setInfo("");
      await loadDevices();
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = async (id: number, status: "active" | "blocked") => {
    setBusyId(id);
    await api.patch(`/reader-devices/${id}/status`, { status });
    setBusyId(null);
    await loadDevices();
  };

  const deleteDevice = async (id: number) => {
    setBusyId(id);
    await api.delete(`/reader-devices/${id}`);
    setBusyId(null);
    await loadDevices();
  };

  const filteredDevices = useMemo(() => {
    const q = query.toLowerCase();
    return devices.filter((d) =>
      `${d.device_name} ${d.device_serial} ${d.device_token} ${d.status}`
        .toLowerCase()
        .includes(q)
    );
  }, [devices, query]);

  if (!isAdmin) {
    return (
      <View style={styles.center}>
        <Ionicons name="lock-closed-outline" size={32} color="#9ca3af" />
        <Text>Admin only</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Reader Devices</Text>
        <Button variant="ghost" onPress={loadDevices}>
          Refresh
        </Button>
      </View>

      <Card style={styles.card}>
        <Text style={styles.sectionTitle}>Register Device</Text>

        <TextInput
          style={styles.input}
          placeholder="Device Serial"
          value={serial}
          onChangeText={setSerial}
        />
        <TextInput
          style={styles.input}
          placeholder="Device Name"
          value={name}
          onChangeText={setName}
        />
        <TextInput
          style={styles.input}
          placeholder="Device Info (optional)"
          value={info}
          onChangeText={setInfo}
        />

        <Button onPress={createDevice} disabled={loading}>
          Register
        </Button>
      </Card>

      <Card style={styles.card}>
        <TextInput
          style={styles.input}
          placeholder="Search..."
          value={query}
          onChangeText={setQuery}
        />
        <Text style={styles.countText}>
          Showing {filteredDevices.length} of {devices.length}
        </Text>
      </Card>

      {loading ? (
        <ActivityIndicator />
      ) : (
        <FlatList
          style={{ flex: 1, minHeight: 240 }}
          data={filteredDevices}
          keyExtractor={(d) => String(d.device_id)}
          contentContainerStyle={{ paddingBottom: 24 }}
          renderItem={({ item }) => {
            const active = item.status === "active";
            return (
              <Card style={styles.card}>
                <Text style={styles.deviceName}>{item.device_name}</Text>
                <Text style={styles.meta}>Serial: {item.device_serial}</Text>
                <Text style={styles.meta}>Token: {item.device_token}</Text>

                <View style={styles.row}>
                  <Button
                    variant={active ? "ghost" : "solid"}
                    onPress={() =>
                      updateStatus(
                        item.device_id,
                        active ? "blocked" : "active"
                      )
                    }
                    disabled={busyId === item.device_id}
                  >
                    {active ? "Block" : "Activate"}
                  </Button>

                  <Button
                    variant="danger"
                    onPress={() => deleteDevice(item.device_id)}
                    disabled={busyId === item.device_id}
                  >
                    Delete
                  </Button>
                </View>
              </Card>
            );
          }}
        />
      )}

      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: "#f8fafc" },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  title: { fontSize: 22, fontWeight: "700" },
  sectionTitle: { fontWeight: "700", marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  card: { padding: 14, marginBottom: 12 },
  deviceName: { fontWeight: "600" },
  meta: { fontSize: 12, color: "#6b7280" },
  row: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 8,
  },
  countText: { fontSize: 12, color: "#6b7280" },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  error: { color: "red", textAlign: "center" },
});