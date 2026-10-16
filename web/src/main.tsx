import ReactDOM from "react-dom/client";
import App from "./App";
import LoginGate from "./components/LoginGate";
import "./style.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <LoginGate>
    <App />
  </LoginGate>,
);
