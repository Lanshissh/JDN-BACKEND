// contexts/AuthContext.tsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/** Shape we expect from the JWT payload */
export type AuthUser = {
  user_id: string;
  user_fullname: string;
  user_roles: string[];
  building_ids: string[];
  utility_role: string[];
};

type AuthContextType = {
  isLoggedIn: boolean;
  loading: boolean;
  token: string | null;
  expiresAt: number | null; // ms epoch
  user: AuthUser | null;

  login: (token: string) => Promise<void>;
  logout: () => Promise<void>;

  // convenience guards
  hasRole: (...roles: string[]) => boolean;
  inBuilding: (...buildingIds: string[]) => boolean;
  hasUtility: (...utils: string[]) => boolean;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/* ---------------- helpers (frontend-only) ---------------- */
const safeAtob = (b64: string): string | null => {
  try {
    // web / RN web
    // @ts-ignore
    if (typeof globalThis.atob === "function") return globalThis.atob(b64);
  } catch {}
  try {
    // RN / Node fallback
    // @ts-ignore
    if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
  } catch {}
  return null;
};

const decodeJwt = (jwt: string): any | null => {
  try {
    const payloadB64 = jwt.split(".")[1];
    if (!payloadB64) return null;
    const base64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const json = safeAtob(base64);
    if (!json) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
};

const getExpMsFromJwt = (jwt: string): number => {
  const p = decodeJwt(jwt);
  if (p && typeof p.exp === "number") return p.exp * 1000;
  // fallback if token lacks exp (keeps user around for 1h)
  return Date.now() + 60 * 60 * 1000;
};

const getUserFromJwt = (jwt: string): AuthUser | null => {
  const p = decodeJwt(jwt);
  if (!p) return null;
  return {
    user_id: String(p.user_id ?? ""),
    user_fullname: String(p.user_fullname ?? ""),
    user_roles: Array.isArray(p.user_roles) ? p.user_roles : [],
    building_ids: Array.isArray(p.building_ids) ? p.building_ids : [],
    utility_role: Array.isArray(p.utility_role) ? p.utility_role : [],
  };
};

/* ---------------- provider ---------------- */
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [loading, setLoading] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const scheduleAutoLogout = (expMs: number) => {
    clearTimer();
    const ms = Math.max(0, expMs - Date.now());
    timerRef.current = setTimeout(() => {
      logout();
    }, ms);
  };

  // load session on mount
  useEffect(() => {
    const init = async () => {
      try {
        const [storedToken, storedExp, storedUser] = await Promise.all([
          AsyncStorage.getItem("token"),
          AsyncStorage.getItem("expiresAt"),
          AsyncStorage.getItem("user"),
        ]);

        const expMs =
          storedExp != null
            ? parseInt(storedExp, 10)
            : storedToken
            ? getExpMsFromJwt(storedToken)
            : null;

        if (!storedToken || !expMs || Date.now() >= expMs) {
          await AsyncStorage.multiRemove(["token", "expiresAt", "user"]);
          setIsLoggedIn(false);
          setToken(null);
          setExpiresAt(null);
          setUser(null);
          return;
        }

        setToken(storedToken);
        setExpiresAt(expMs);
        setIsLoggedIn(true);

        // prefer decoding the token (source of truth)
        const decoded = getUserFromJwt(storedToken);
        if (decoded) {
          setUser(decoded);
          await AsyncStorage.setItem("user", JSON.stringify(decoded));
        } else if (storedUser) {
          setUser(JSON.parse(storedUser));
        } else {
          setUser(null);
        }

        scheduleAutoLogout(expMs);
      } finally {
        setLoading(false);
      }
    };
    init();
    return clearTimer; // cleanup on unmount
  }, []);

  const login = async (newToken: string) => {
    const expMs = getExpMsFromJwt(newToken);
    const decoded = getUserFromJwt(newToken);

    setToken(newToken);
    setExpiresAt(expMs);
    setIsLoggedIn(true);
    setUser(decoded);

    scheduleAutoLogout(expMs);

    await AsyncStorage.multiSet([
      ["token", newToken],
      ["expiresAt", String(expMs)],
      ["user", JSON.stringify(decoded)],
    ]);
  };

  const logout = async () => {
    clearTimer();
    setIsLoggedIn(false);
    setToken(null);
    setExpiresAt(null);
    setUser(null);
    await AsyncStorage.multiRemove(["token", "expiresAt", "user"]);
  };

  // convenience guards
  const hasRole = (...roles: string[]) =>
    !!user && roles.some((r) => user.user_roles.includes(r));

  const inBuilding = (...buildingIds: string[]) =>
    !!user && buildingIds.some((b) => user.building_ids.includes(b));

  const hasUtility = (...utils: string[]) =>
    !!user && utils.some((u) => user.utility_role.includes(u));

  const value = useMemo<AuthContextType>(
    () => ({
      isLoggedIn,
      loading,
      token,
      expiresAt,
      user,
      login,
      logout,
      hasRole,
      inBuilding,
      hasUtility,
    }),
    [isLoggedIn, loading, token, expiresAt, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};