import { useColorScheme } from "@/hooks/useColorScheme";
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider,
} from "@react-navigation/native";
import { useFonts } from "expo-font";
import { Redirect, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Platform } from "react-native";
import "react-native-reanimated";
import { AuthProvider, useAuth } from "../contexts/AuthContext";
import { ScanHistoryProvider } from "../contexts/ScanHistoryContext";

function RootLayoutNav() {
  const { isLoggedIn, loading } = useAuth();

  console.log("🧭 isLoggedIn:", isLoggedIn, "loading:", loading);

  if (loading) return null;

  const needsLoginOnMobile = Platform.OS !== "web" && !isLoggedIn;

  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="(auth)/login" />
        <Stack.Screen name="+not-found" />
      </Stack>

      {needsLoginOnMobile ? <Redirect href="/(auth)/login" /> : null}
    </>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [loaded] = useFonts({
    SpaceMono: require("../assets/fonts/SpaceMono-Regular.ttf"),
  });

  if (!loaded) return null;

  return (
    <AuthProvider>
      <ScanHistoryProvider>
        <ThemeProvider
          value={colorScheme === "dark" ? DarkTheme : DefaultTheme}
        >
          <RootLayoutNav />
          <StatusBar style="auto" />
        </ThemeProvider>
      </ScanHistoryProvider>
    </AuthProvider>
  );
}