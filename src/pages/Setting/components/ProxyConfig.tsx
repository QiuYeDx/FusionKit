import useProxyStore, { ProxyMode } from "@/store/useProxyStore";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ButtonGroup } from "@/components/ui/button-group";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

function ProxyConfig() {
  const { t } = useTranslation();
  const { proxyConfig, setProxyMode, setProxyHost, setProxyPort } =
    useProxyStore();

  return (
    <Card className="overflow-auto">
      <CardHeader className="sticky left-0">
        <CardTitle className="text-xl">
          {t("setting:subtitle.proxy_config")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center gap-4">
          <Label className="text-sm font-medium min-w-[80px]">
            {t("setting:fields.proxy.mode")}
          </Label>
          <ButtonGroup>
            <Button
              size="sm"
              variant={
                proxyConfig.mode === ProxyMode.NONE ? "default" : "outline"
              }
              onClick={() => setProxyMode(ProxyMode.NONE)}
            >
              {t("setting:fields.proxy.none")}
            </Button>
            <Button
              size="sm"
              variant={
                proxyConfig.mode === ProxyMode.SYSTEM ? "default" : "outline"
              }
              onClick={() => setProxyMode(ProxyMode.SYSTEM)}
            >
              {t("setting:fields.proxy.system")}
            </Button>
            <Button
              size="sm"
              variant={
                proxyConfig.mode === ProxyMode.CUSTOM ? "default" : "outline"
              }
              onClick={() => setProxyMode(ProxyMode.CUSTOM)}
            >
              {t("setting:fields.proxy.custom")}
            </Button>
          </ButtonGroup>
        </div>

        {proxyConfig.mode === ProxyMode.CUSTOM && (
          <div className="grid grid-cols-1 md:grid-cols-[1fr_120px] gap-4 max-w-2xl">
            <div className="space-y-2">
              <Label htmlFor="proxy-host">
                {t("setting:fields.proxy.host")}
              </Label>
              <Input
                id="proxy-host"
                type="text"
                placeholder={t("setting:placeholder.proxy_host")}
                value={proxyConfig.host}
                onChange={(e) => setProxyHost(e.target.value)}
                className="w-full"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="proxy-port">
                {t("setting:fields.proxy.port")}
              </Label>
              <Input
                id="proxy-port"
                type="text"
                inputMode="numeric"
                placeholder={t("setting:placeholder.proxy_port")}
                value={proxyConfig.port}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, "");
                  setProxyPort(val);
                }}
                className="w-full"
              />
            </div>
          </div>
        )}

        <div className="text-xs text-muted-foreground max-w-2xl">
          {proxyConfig.mode === ProxyMode.NONE &&
            t("setting:fields.proxy.none_desc")}
          {proxyConfig.mode === ProxyMode.SYSTEM &&
            t("setting:fields.proxy.system_desc")}
          {proxyConfig.mode === ProxyMode.CUSTOM &&
            t("setting:fields.proxy.custom_desc")}
        </div>
      </CardContent>
    </Card>
  );
}

export default ProxyConfig;
