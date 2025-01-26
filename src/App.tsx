import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import "./App.css";
import About from "./pages/About";
import Setting from "./pages/Setting";
import Home from "./pages/Home";
import Tools from "./pages/Tools";
import useInitializeTheme from "@/hook/useInitializeTheme";
import BottomNavigation from "@/pages/components/BottomNavigation";

function App() {
  // 初始化主题
  useInitializeTheme();

  return (
    <div className="App">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/tools" element={<Tools />} />
        <Route path="/about" element={<About />} />
        <Route path="/setting" element={<Setting />} />
      </Routes>

      {/* 底部导航栏 */}
      <BottomNavigation />
    </div>
  );
}

export default App;
