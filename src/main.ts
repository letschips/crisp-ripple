import { App, ItemView, Notice, Plugin, PluginSettingTab, Setting, View } from "obsidian";
import { preserveUnreadableData } from "./data-safety";
import { AsciiField, FieldColors, FieldTuning, Rgb } from "./field";
import { LicensePayload, discoverVaultCrispLicense, verifyLicenseCode } from "./license";
import {
  ColorMode,
  DEFAULT_VISUALS,
  RANGES,
  RippleSettings,
  VisualSettings,
  effectiveVisuals,
  normalizeSettings,
  soundEnabled,
} from "./settings";
import { DropSound } from "./sound";

const PLUGIN_ID = "crisp-ripple";
const HOST_CLASS = "crisp-ripple-host";
const CANVAS_CLASS = "crisp-ripple-canvas";
const AUTHOR_URL = "https://xhslink.cn/m/3MwtKu4822b";

interface LicenseState {
  valid: boolean;
  payload?: LicensePayload;
  reason?: string;
}

function parseColor(value: string, fallback: Rgb): Rgb {
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe || !value.trim()) return fallback;
  probe.fillStyle = "#000";
  probe.fillStyle = value.trim();
  const normalized = String(probe.fillStyle);
  const hex = /^#([0-9a-f]{6})$/i.exec(normalized);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const rgb = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(normalized);
  if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
  return fallback;
}

function readTheme(visuals: VisualSettings): { colors: FieldColors; font: string } {
  const style = getComputedStyle(document.body);
  const base = parseColor(style.getPropertyValue("--text-muted"), { r: 120, g: 120, b: 120 });
  const fallback = { r: 80, g: 110, b: 230 };
  const accent =
    visuals.colorMode === "custom"
      ? parseColor(visuals.customColor, fallback)
      : parseColor(
          style.getPropertyValue(visuals.colorMode === "accent" ? "--interactive-accent" : "--color-blue"),
          fallback,
        );
  const family = style.getPropertyValue("--font-monospace").trim() || "monospace";
  return { colors: { base, accent }, font: `12px ${family}` };
}

function tuningOf(visuals: VisualSettings): FieldTuning {
  return { speed: visuals.speed / 100, strength: visuals.strength / 100, density: visuals.density / 100 };
}

class EmptyTabRipple {
  private readonly canvas: HTMLCanvasElement;
  private readonly field: AsciiField;
  private readonly observer: ResizeObserver;
  private readonly host: HTMLElement;

  constructor(
    view: View,
    reducedMotion: boolean,
    private readonly visuals: () => VisualSettings,
    private readonly onDrop: (pan: number) => void,
  ) {
    // The core "empty" view is an ItemView at runtime; its .view-content hosts the actions.
    const host = (view as ItemView).contentEl;
    this.host = host;
    host.addClass(HOST_CLASS);
    this.canvas = host.createEl("canvas", { cls: CANVAS_CLASS });
    this.canvas.setAttr("aria-hidden", "true");
    host.prepend(this.canvas);
    const { colors, font } = readTheme(visuals());
    this.field = new AsciiField(this.canvas, colors, font, reducedMotion);
    this.field.setTuning(tuningOf(visuals()));
    this.observer = new ResizeObserver(() => this.syncSize());
    this.observer.observe(host);
    host.addEventListener("pointerdown", this.onPointerDown);
    this.syncSize();
  }

  get attached(): boolean {
    return this.canvas.isConnected;
  }

  refresh(): void {
    const { colors, font } = readTheme(this.visuals());
    this.field.setColors(colors, font);
    this.field.setTuning(tuningOf(this.visuals()));
  }

  destroy(): void {
    this.field.stop();
    this.observer.disconnect();
    this.host.removeEventListener("pointerdown", this.onPointerDown);
    this.host.removeClass(HOST_CLASS);
    this.canvas.remove();
  }

  private syncSize(): void {
    const { width, height } = this.host.getBoundingClientRect();
    if (width < 1 || height < 1) {
      this.field.stop();
      return;
    }
    this.field.resize(width, height);
    this.field.start();
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    this.field.addRipple(x, event.clientY - rect.top);
    // Pan the drop toward where it landed; kept narrow so it stays subtle.
    this.onDrop(((x / Math.max(1, rect.width)) * 2 - 1) * 0.6);
  };
}

export default class CrispRipplePlugin extends Plugin {
  private ripples = new Map<View, EmptyTabRipple>();
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private rippleSettings: RippleSettings = normalizeSettings(undefined);
  private readonly sound = new DropSound();
  private dataWriteBlocked = false;
  private settingTab: RippleSettingTab | null = null;
  license: LicenseState = { valid: false };

  // Never overwrite a data.json that could not be read and could not be backed up either.
  async saveData(data: unknown): Promise<void> {
    if (this.dataWriteBlocked) return;
    await super.saveData(data);
  }

  async onload(): Promise<void> {
    const raw = await this.loadData();
    await this.protectUnreadableData(raw);
    this.rippleSettings = normalizeSettings(raw ?? {});
    // Startup stays local: only the embedded-key signature check, the online check runs later.
    if (this.rippleSettings.licenseCode) {
      this.license = await this.checkLicense(this.rippleSettings.licenseCode, false);
    }

    this.settingTab = new RippleSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.addCommand({
      id: "toggle-sound",
      name: "Toggle water-drop sound",
      callback: async () => {
        if (!this.license.valid) {
          new Notice("Crisp Ripple：水滴音效需要激活后使用");
          return;
        }
        this.rippleSettings.sound = !this.rippleSettings.sound;
        await this.saveSettings();
        new Notice(`Crisp Ripple sound ${this.rippleSettings.sound ? "on" : "off"}`);
        this.settingTab?.display();
      },
    });
    this.app.workspace.onLayoutReady(() => {
      this.sync();
      void this.refreshLicenseInBackground();
    });
    this.registerEvent(this.app.workspace.on("layout-change", () => this.sync()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.sync()));
    this.registerEvent(this.app.workspace.on("css-change", () => this.applyVisuals()));
  }

  onunload(): void {
    for (const ripple of this.ripples.values()) ripple.destroy();
    this.ripples.clear();
    this.sound.dispose();
  }

  get options(): RippleSettings {
    return this.rippleSettings;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.rippleSettings);
  }

  /** Re-applies colour and tuning to every open empty tab. */
  applyVisuals(): void {
    for (const ripple of this.ripples.values()) ripple.refresh();
  }

  async resetVisuals(): Promise<void> {
    Object.assign(this.rippleSettings, DEFAULT_VISUALS);
    await this.saveSettings();
    this.applyVisuals();
  }

  previewDrop(): void {
    if (!soundEnabled(this.rippleSettings, this.license.valid)) return;
    this.sound.play({ pan: 0, seed: Math.random(), volume: this.rippleSettings.volume / 100 });
  }

  async activate(code: string): Promise<LicenseState> {
    const result = await this.checkLicense(code, true);
    if (result.valid) {
      this.rippleSettings.licenseCode = code.trim();
      await this.saveSettings();
      this.license = result;
      this.applyVisuals();
    }
    return result;
  }

  async clearLicense(): Promise<void> {
    this.rippleSettings.licenseCode = "";
    await this.saveSettings();
    this.license = { valid: false };
    this.applyVisuals();
  }

  private async checkLicense(code: string, online: boolean): Promise<LicenseState> {
    const result = await verifyLicenseCode(code, PLUGIN_ID, online ? undefined : { online: false });
    return { valid: result.valid, payload: result.payload, reason: result.reason };
  }

  /** Online revocation/device check for a stored code, or inheriting a code from sibling Crisp plugins. */
  private async refreshLicenseInBackground(): Promise<void> {
    try {
      const code = this.rippleSettings.licenseCode;
      if (code) {
        const result = await this.checkLicense(code, true);
        if (result.valid !== this.license.valid || result.reason !== this.license.reason) {
          this.license = result;
          this.applyVisuals();
          this.settingTab?.display();
        }
        return;
      }
      const inherited = await discoverVaultCrispLicense(this.app, PLUGIN_ID);
      if (!inherited) return;
      const result = await this.checkLicense(inherited, false);
      if (!result.valid) return;
      this.rippleSettings.licenseCode = inherited;
      await this.saveSettings();
      this.license = result;
      this.applyVisuals();
      this.settingTab?.display();
    } catch (error) {
      console.debug("Crisp Ripple background license check failed", error);
    }
  }

  // loadData() yields undefined when data.json exists but cannot be read; keep a copy before defaults take over.
  private async protectUnreadableData(raw: unknown): Promise<void> {
    if (raw !== undefined) return;
    const result = await preserveUnreadableData(this.app.vault.adapter, `${this.manifest.dir}/data.json`);
    if (result.state === "preserved") {
      new Notice(`Crisp Ripple 的设置文件无法读取，已备份为 ${result.backupPath.split("/").pop()} 并恢复默认设置。`, 12000);
    } else if (result.state === "failed") {
      this.dataWriteBlocked = true;
      console.error("Crisp Ripple could not back up unreadable data.json", result.error);
      new Notice("Crisp Ripple 的设置文件无法读取，也无法备份。为保护原文件，本次运行不会保存设置。", 0);
    }
  }

  private visuals = (): VisualSettings => effectiveVisuals(this.rippleSettings, this.license.valid);

  private playDrop = (pan: number): void => {
    if (!soundEnabled(this.rippleSettings, this.license.valid)) return;
    this.sound.play({ pan, seed: Math.random(), volume: this.rippleSettings.volume / 100 });
  };

  private sync(): void {
    const views = new Set<View>();
    for (const leaf of this.app.workspace.getLeavesOfType("empty")) views.add(leaf.view);
    for (const [view, ripple] of this.ripples) {
      if (!views.has(view) || !ripple.attached) {
        ripple.destroy();
        this.ripples.delete(view);
      }
    }
    for (const view of views) {
      if (!this.ripples.has(view)) {
        this.ripples.set(view, new EmptyTabRipple(view, this.reducedMotion, this.visuals, this.playDrop));
      }
    }
  }
}

class RippleSettingTab extends PluginSettingTab {
  private licenseDraft = "";
  private checking = false;

  constructor(app: App, private readonly plugin: CrispRipplePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.options;
    const licensed = this.plugin.license.valid;

    this.renderLicense(containerEl);

    new Setting(containerEl).setName("点击音效").setHeading();
    if (!licensed) this.lockedNote(containerEl, "水滴音效需要激活后使用。");

    new Setting(containerEl)
      .setName("点击音效")
      .setDesc("在空标签页点击时播放水滴落水的声音。")
      .setDisabled(!licensed)
      .addToggle((toggle) =>
        toggle
          .setValue(licensed && settings.sound)
          .setDisabled(!licensed)
          .onChange(async (value) => {
            settings.sound = value;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    const soundOn = licensed && settings.sound;
    new Setting(containerEl)
      .setName("音量")
      .setDesc("100% 为默认音量。")
      .setDisabled(!soundOn)
      .addSlider((slider) =>
        slider
          .setLimits(RANGES.volume[0], RANGES.volume[1], 10)
          .setValue(settings.volume)
          .setDynamicTooltip()
          .setDisabled(!soundOn)
          .onChange(async (value) => {
            settings.volume = value;
            await this.plugin.saveSettings();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("试听")
          .setDisabled(!soundOn)
          .onClick(() => this.plugin.previewDrop()),
      );

    new Setting(containerEl).setName("波纹外观").setHeading();
    if (!licensed) this.lockedNote(containerEl, "未激活时使用默认外观；调节颜色、速度和浓淡需要激活。");

    const save = async (): Promise<void> => {
      await this.plugin.saveSettings();
      this.plugin.applyVisuals();
    };

    new Setting(containerEl)
      .setName("波纹颜色")
      .setDesc("默认跟随主题的蓝色；也可以用主题强调色，或自己选一个颜色。")
      .setDisabled(!licensed)
      .addDropdown((dropdown) =>
        dropdown
          .addOption("blue", "主题蓝色")
          .addOption("accent", "主题强调色")
          .addOption("custom", "自定义")
          .setValue(licensed ? settings.colorMode : DEFAULT_VISUALS.colorMode)
          .setDisabled(!licensed)
          .onChange(async (value) => {
            settings.colorMode = value as ColorMode;
            await save();
            this.display();
          }),
      );

    if (licensed && settings.colorMode === "custom") {
      new Setting(containerEl).setName("自定义颜色").addColorPicker((picker) =>
        picker.setValue(settings.customColor).onChange(async (value) => {
          settings.customColor = value;
          await save();
        }),
      );
    }

    this.addPercentSlider("波纹速度", "波纹扩散和消失的快慢。", "speed", licensed, save);
    this.addPercentSlider("波纹浓淡", "点击后那一圈波纹的深浅。", "strength", licensed, save);
    this.addPercentSlider("背景浓淡", "平时缓慢漂移的背景字符的深浅，0% 为隐藏。", "density", licensed, save);

    new Setting(containerEl).setDisabled(!licensed).addButton((button) =>
      button
        .setButtonText("恢复默认外观")
        .setDisabled(!licensed)
        .onClick(async () => {
          await this.plugin.resetVisuals();
          this.display();
        }),
    );

    this.renderAbout(containerEl);
  }

  private renderLicense(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("软件授权与激活").setHeading();
    const license = this.plugin.license;
    const status = new Setting(containerEl).setName("激活状态");
    if (license.valid) {
      const payload = license.payload;
      const user = payload?.userName || "Crisp 用户";
      const expiry = payload?.expiresAt ? `到期时间：${String(payload.expiresAt).split("T")[0]}` : "永久授权";
      status.setDesc(`已激活（授权用户：${user} · ${expiry}）`);
      status.addButton((button) =>
        button
          .setButtonText("清除授权")
          .setWarning()
          .onClick(async () => {
            await this.plugin.clearLicense();
            this.licenseDraft = "";
            new Notice("已清除授权信息");
            this.display();
          }),
      );
    } else {
      status.setDesc(
        license.reason
          ? `未激活：${license.reason}`
          : "未激活。背景字符和默认波纹可以直接使用；水滴音效和外观调节需要激活。",
      );
    }

    if (license.valid) return;
    new Setting(containerEl)
      .setName("授权码")
      .setDesc("支持 Crisp Suite 全家桶或单款授权码。启动时会自动继承库内其他 Crisp 插件的授权。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("粘贴 Crisp 授权码…")
          .setValue(this.licenseDraft)
          .onChange((value) => {
            this.licenseDraft = value.trim();
          });
      })
      .addButton((button) =>
        button
          .setButtonText(this.checking ? "验证中…" : "激活")
          .setCta()
          .setDisabled(this.checking)
          .onClick(async () => {
            const code = this.licenseDraft || this.plugin.options.licenseCode;
            if (!code) {
              new Notice("请先输入授权码");
              return;
            }
            this.checking = true;
            this.display();
            try {
              const result = await this.plugin.activate(code);
              if (result.valid) {
                this.licenseDraft = "";
                new Notice(`Crisp Ripple 激活成功，欢迎使用，${result.payload?.userName || "Crisp 用户"}`);
              } else {
                new Notice(`激活未通过：${result.reason || "未知原因"}`);
              }
            } finally {
              this.checking = false;
              this.display();
            }
          }),
      );
  }

  private lockedNote(containerEl: HTMLElement, text: string): void {
    containerEl.createDiv({ cls: "crisp-ripple-locked setting-item-description", text });
  }

  private renderAbout(containerEl: HTMLElement): void {
    const card = containerEl.createDiv({ cls: "crisp-ripple-about" });
    card.createDiv({ cls: "crisp-ripple-about__title", text: `关于 Crisp Ripple ${this.plugin.manifest.version}` });
    card.createDiv({ cls: "crisp-ripple-about__description", text: "让空标签页泛起一圈字符波纹。" });
    const byline = card.createEl("p", { cls: "crisp-ripple-about__author" });
    byline.createSpan({ text: "作者：" });
    const link = byline.createEl("a", { cls: "crisp-ripple-about__author-link", text: "小红书 letschips", href: AUTHOR_URL });
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }

  private addPercentSlider(
    name: string,
    desc: string,
    key: "speed" | "strength" | "density",
    licensed: boolean,
    save: () => Promise<void>,
  ): void {
    const settings = this.plugin.options;
    const [min, max] = RANGES[key];
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(`${desc}100% 为默认。`)
      .setDisabled(!licensed)
      .addSlider((slider) =>
        slider
          .setLimits(min, max, 10)
          .setValue(licensed ? settings[key] : DEFAULT_VISUALS[key])
          .setDynamicTooltip()
          .setDisabled(!licensed)
          .onChange(async (value) => {
            settings[key] = value;
            await save();
          }),
      );
  }
}
