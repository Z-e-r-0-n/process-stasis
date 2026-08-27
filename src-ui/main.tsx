import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "uplot/dist/uPlot.min.css";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
