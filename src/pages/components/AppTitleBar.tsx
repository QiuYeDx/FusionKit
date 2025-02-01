function AppTitleBar() {
  // TODO: macOS 高度 24px, Windows 下的高度待确认, 可能需要为动态高度
  return (
    <div className="app-region-drag glass h-6 w-full fixed z-50 top-0 flex justify-center items-center text-xs font-mono">
      FusionKit
    </div>
  );
}

export default AppTitleBar;
