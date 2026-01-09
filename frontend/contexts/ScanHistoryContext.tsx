import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import axios from "axios";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { BASE_API } from "../constants/api";

export type OfflineScan = {
  id: string;
  meter_id: string;
  reading_value: number;
  lastread_date: string;
  createdAt: string;
  status: "pending" | "approved" | "failed";
  error?: string;
  remarks?: string;

  // ✅ Added: support storing compressed image base64 (hybrid offline)
  image?: string;
};

type ResolveDeviceResult = {
  device_id: number;
  device_serial: string;
  device_name: string;
  device_token: string;
  status: "active" | "blocked";
};

type OfflineImportResult = {
  device: { device_id: number; device_name: string; device_serial: string };
  data: { meters: any[]; tenants: any[]; stalls: any[] };
  generated_at: string;
};

type Ctx = {
  scans: OfflineScan[];
  isConnected: boolean | null;

  // ✅ Updated: include image in queue payload type support
  queueScan: (s: Omit<OfflineScan, "id" | "createdAt" | "status">) => Promise<void>;
  removeScan: (id: string) => Promise<void>;
  markPending: (id: string) => Promise<void>;
  markApproved: (id: string) => Promise<void>;

  approveOne: (id: string, token: string | null) => Promise<void>;
  approveAll: (token: string | null) => Promise<void>;
  reload: () => Promise<void>;

  deviceToken: string | null;
  deviceName: string | null;

  clearDevice: () => Promise<void>;

  // resolve device token by serial (after login)
  resolveDevice: (
    authToken: string | null,
    deviceSerial: string,
    deviceInfo?: string
  ) => Promise<ResolveDeviceResult>;

  // import offline dataset (token gated)
  importOfflineData: (authToken: string | null) => Promise<OfflineImportResult>;

  // export offline readings to staging (token gated)
  exportOfflineReadings: (
    authToken: string | null,
    readings?: OfflineScan[]
  ) => Promise<{ submission_id?: number; received: number }>;
};

const ScanHistoryContext = createContext<Ctx | null>(null);

const STORAGE_KEY = "offline_scans_v1";
const DEVICE_TOKEN_KEY = "offline_device_token_v1";
const DEVICE_NAME_KEY = "offline_device_name_v1";

export function ScanHistoryProvider({ children }: { children: React.ReactNode }) {
  const [scans, setScans] = useState<OfflineScan[]>([]);
  const [isConnected, setIsConnected] = useState<boolean | null>(null);

  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);

  // network status
  useEffect(() => {
    const sub = NetInfo.addEventListener((state) => setIsConnected(!!state.isConnected));
    NetInfo.fetch().then((s) => setIsConnected(!!s.isConnected));
    return () => {
      if (sub) sub();
    };
  }, []);

  const reload = useCallback(async () => {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    setScans(raw ? (JSON.parse(raw) as OfflineScan[]) : []);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = useCallback(async (items: OfflineScan[]) => {
    setScans(items);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }, []);

  // load token + name on startup
  useEffect(() => {
    (async () => {
      const t = await AsyncStorage.getItem(DEVICE_TOKEN_KEY);
      const n = await AsyncStorage.getItem(DEVICE_NAME_KEY);
      if (t) setDeviceToken(t);
      if (n) setDeviceName(n);
    })();
  }, []);

  const saveDevice = useCallback(async (token: string | null, name: string | null) => {
    setDeviceToken(token);
    setDeviceName(name);

    if (token) await AsyncStorage.setItem(DEVICE_TOKEN_KEY, token);
    else await AsyncStorage.removeItem(DEVICE_TOKEN_KEY);

    if (name) await AsyncStorage.setItem(DEVICE_NAME_KEY, name);
    else await AsyncStorage.removeItem(DEVICE_NAME_KEY);
  }, []);

  const clearDevice = useCallback(async () => {
    await saveDevice(null, null);
  }, [saveDevice]);

  const queueScan: Ctx["queueScan"] = useCallback(
    async ({ meter_id, reading_value, lastread_date, remarks, image }) => {
      const item: OfflineScan = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        meter_id,
        reading_value,
        lastread_date,
        createdAt: new Date().toISOString(),
        status: "pending",
        remarks,
        image, // ✅ store compressed base64 (or empty string)
      };
      await save([item, ...scans]);
    },
    [save, scans]
  );

  const removeScan: Ctx["removeScan"] = useCallback(
    async (id) => {
      const updated = scans.filter((s) => s.id !== id);
      await save(updated);
    },
    [save, scans]
  );

  const markPending: Ctx["markPending"] = useCallback(
    async (id) => {
      const updated = scans.map((s) =>
        s.id === id ? { ...s, status: "pending" as const, error: undefined } : s
      );
      await save(updated);
    },
    [save, scans]
  );

  const markApproved: Ctx["markApproved"] = useCallback(
    async (id) => {
      const updated = scans.map((s) =>
        s.id === id ? { ...s, status: "approved" as const, error: undefined } : s
      );
      await save(updated);
    },
    [save, scans]
  );

  const makeApi = (authToken: string) =>
    axios.create({
      baseURL: BASE_API,
      timeout: 20000,
      headers: { Authorization: `Bearer ${authToken}` },
    });

  // resolve device by serial (reader after login)
  const resolveDevice: Ctx["resolveDevice"] = useCallback(
    async (authToken, deviceSerial, deviceInfo) => {
      if (!authToken) throw new Error("Missing auth token");
      const api = makeApi(authToken);

      const res = await api.post<ResolveDeviceResult>("/reader-devices/resolve", {
        device_serial: deviceSerial,
        device_info: deviceInfo,
      });

      const dt = res.data?.device_token || null;
      const dn = res.data?.device_name || null;

      await saveDevice(dt, dn);
      return res.data;
    },
    [saveDevice]
  );

  // ✅ UPDATED: import offline dataset (token gated) -> offlineExport prefix
  const importOfflineData: Ctx["importOfflineData"] = useCallback(
    async (authToken) => {
      if (!authToken) throw new Error("Missing auth token");
      if (!deviceToken) throw new Error("Device not registered. Ask admin to register serial.");

      const api = makeApi(authToken);

      // IMPORTANT: your API prefix is /offlineExport
      const res = await api.post<OfflineImportResult>("/offlineExport/import", {
        device_token: deviceToken,
      });

      return res.data;
    },
    [deviceToken]
  );

  // ✅ UPDATED: export offline readings to staging -> offlineExport prefix
  const exportOfflineReadings: Ctx["exportOfflineReadings"] = useCallback(
    async (authToken, readingsOpt) => {
      const readings =
        readingsOpt ??
        scans.filter((x) => x.status === "pending" || x.status === "failed");

      if (!readings.length) return { received: 0 };

      if (!authToken) throw new Error("Missing auth token");
      if (!deviceToken) throw new Error("Device not registered for offline sync.");

      const api = makeApi(authToken);

      // IMPORTANT: your API prefix is /offlineExport
      const res = await api.post("/offlineExport/export", {
        device_token: deviceToken,
        readings: readings.map((s) => ({
          meter_id: s.meter_id,
          reading_value: s.reading_value,
          lastread_date: s.lastread_date,
          remarks: s.remarks,
          image: s.image, // ✅ keep in payload_json for audit if you want
        })),
      });

      // mark exported ones as approved locally (server accepted)
      const updated = scans.map((s) =>
        readings.some((p) => p.id === s.id)
          ? ({ ...s, status: "approved" as const, error: undefined } as OfflineScan)
          : s
      );

      await save(updated);

      return { submission_id: res?.data?.submission_id, received: readings.length };
    },
    [scans, deviceToken, save]
  );

  // approveOne/approveAll call exportOfflineReadings with 1 or many.
  const approveOne: Ctx["approveOne"] = useCallback(
    async (id, token) => {
      const target = scans.find((s) => s.id === id);
      if (!target) return;

      try {
        await exportOfflineReadings(token, [target]);
      } catch (e: any) {
        const errMsg =
          e?.response?.data?.error ||
          e?.response?.data?.message ||
          e?.message ||
          String(e);

        const updated = scans.map((s) =>
          s.id === id ? ({ ...s, status: "failed" as const, error: errMsg } as OfflineScan) : s
        );
        await save(updated);
      }
    },
    [exportOfflineReadings, scans, save]
  );

  const approveAll: Ctx["approveAll"] = useCallback(
    async (token) => {
      try {
        await exportOfflineReadings(token);
      } catch (e: any) {
        const errMsg =
          e?.response?.data?.error ||
          e?.response?.data?.message ||
          e?.message ||
          String(e);

        const pending = scans.filter((x) => x.status === "pending" || x.status === "failed");
        const updated = scans.map((s) =>
          pending.some((p) => p.id === s.id)
            ? ({ ...s, status: "failed" as const, error: errMsg } as OfflineScan)
            : s
        );
        await save(updated);
      }
    },
    [exportOfflineReadings, scans, save]
  );

  const value: Ctx = useMemo(
    () => ({
      scans,
      isConnected,
      queueScan,
      removeScan,
      markPending,
      markApproved,
      approveOne,
      approveAll,
      reload,
      deviceToken,
      deviceName,
      clearDevice,
      resolveDevice,
      importOfflineData,
      exportOfflineReadings,
    }),
    [
      scans,
      isConnected,
      queueScan,
      removeScan,
      markPending,
      markApproved,
      approveOne,
      approveAll,
      reload,
      deviceToken,
      deviceName,
      clearDevice,
      resolveDevice,
      importOfflineData,
      exportOfflineReadings,
    ]
  );

  return <ScanHistoryContext.Provider value={value}>{children}</ScanHistoryContext.Provider>;
}

export function useScanHistory() {
  const ctx = useContext(ScanHistoryContext);
  if (!ctx) throw new Error("useScanHistory must be used inside <ScanHistoryProvider>");
  return ctx;
}