import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout } from "./components/Layout.tsx";
import { AdminPage } from "./pages/AdminPage.tsx";
import { FleetPage } from "./pages/FleetPage.tsx";
import { HistoryPage } from "./pages/HistoryPage.tsx";
import { JobPage } from "./pages/JobPage.tsx";
import { PartPage } from "./pages/PartPage.tsx";
import { PartsPage } from "./pages/PartsPage.tsx";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 10_000 } },
});

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <FleetPage /> },
      { path: "history", element: <HistoryPage /> },
      { path: "jobs/:id", element: <JobPage /> },
      { path: "parts", element: <PartsPage /> },
      { path: "parts/:id", element: <PartPage /> },
      // Charts (Recharts) load only when this page is opened.
      {
        path: "analytics",
        lazy: async () => ({ Component: (await import("./pages/AnalyticsPage.tsx")).AnalyticsPage }),
      },
      // The 3MF parser loads only with the queue.
      {
        path: "queue",
        lazy: async () => ({ Component: (await import("./pages/QueuePage.tsx")).QueuePage }),
      },
      { path: "admin", element: <AdminPage /> },
    ],
  },
]);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
