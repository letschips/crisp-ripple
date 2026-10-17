import { App, ItemView, Notice, Plugin, PluginSettingTab, Setting, View } from "obsidian";
import { preserveUnreadableData, verifyDataWrite } from "./data-safety";
import { parseColor } from "./color";
import { AsciiField, FieldColors, FieldTuning } from "./field";
import { discoverVaultCrispLicenses, verifyLicenseCode } from "./license";
import { ActivationOutcome, LicenseController, LicenseResult } from "./license-controller";
import {
  ColorMode,
  Shape,
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
// Obsidian's empty-tab buttons are `button.empty-state-action`.
const EMPTY_STATE_CONTROLS = ".empty-state-action, button, a, input";
const AUTHOR_URL = "https://xhslink.cn/m/3MwtKu4822b";

// Pop-out windows can carry their own theme variables, so read the document the canvas lives in.
function readTheme(visuals: VisualSettings, doc: Document): { colors: FieldColors; font: string } {
  const style = (doc.defaultView ?? window).getComputedStyle(doc.body);
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
  return {
    speed: visuals.speed / 100,
    strength: visuals.strength / 100,
    density: visuals.density / 100,
    push: visuals.push / 100,
  };
}

class EmptyTabRipple {
  private readonly canvas: HTMLCanvasElement;
  private readonly field: AsciiField;
  private readonly observer: ResizeObserver;
  private readonly host: HTMLElement;
  private readonly motionQuery: MediaQueryList;
  private readonly hostWindow: Window;

  constructor(
    view: View,
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
    // Each window delivers media-query changes only while it renders, so listen on the canvas's own window.
    this.hostWindow = host.ownerDocument.defaultView ?? window;
    this.motionQuery = this.hostWindow.matchMedia("(prefers-reduced-motion: reduce)");
    this.motionQuery.addEventListener("change", this.onMotionChange);
    let field: AsciiField | undefined;
    let observer: ResizeObserver | undefined;
    try {
      const { colors, font } = readTheme(visuals(), host.ownerDocument);
      this.field = field = new AsciiField(this.canvas, colors, font, this.motionQuery.matches);
      field.setShape(visuals().shape);
      field.setTuning(tuningOf(visuals()));
      this.observer = observer = new ResizeObserver(() => this.syncSize());
      observer.observe(host);
      host.addEventListener("pointerdown", this.onPointerDown);
      host.addEventListener("pointermove", this.onPointerMove);
      host.addEventListener("pointerleave", this.onPointerLeave);
      this.syncSize();
    } catch (error) {
      // Leave the tab exactly as Obsidian made it.
      field?.destroy();
      observer?.disconnect();
      this.motionQuery.removeEventListener("change", this.onMotionChange);
      host.removeEventListener("pointerdown", this.onPointerDown);
      host.removeEventListener("pointermove", this.onPointerMove);
      host.removeEventListener("pointerleave", this.onPointerLeave);
      host.removeClass(HOST_CLASS);
      this.canvas.remove();
      throw error;
    }
  }

  /** False once the tab is gone or has moved to another window, where it must be rebuilt. */
  get attached(): boolean {
    return this.canvas.isConnected && this.host.ownerDocument.defaultView === this.hostWindow;
  }

  refresh(): void {
    const { colors, font } = readTheme(this.visuals(), this.host.ownerDocument);
    this.field.setColors(colors, font);
    this.field.setShape(this.visuals().shape);
    this.field.setTuning(tuningOf(this.visuals()));
    // A field that went idle with the background hidden restarts here once a setting can show it.
    this.syncSize();
  }

  destroy(): void {
    this.field.destroy();
    this.motionQuery.removeEventListener("change", this.onMotionChange);
    this.observer.disconnect();
    this.host.removeEventListener("pointerdown", this.onPointerDown);
    this.host.removeEventListener("pointermove", this.onPointerMove);
    this.host.removeEventListener("pointerleave", this.onPointerLeave);
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

  private onMotionChange = (event: MediaQueryListEvent): void => {
    this.field.setReducedMotion(event.matches);
    if (!event.matches) this.syncSize();
  };

  private onPointerMove = (event: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.field.setPointer(event.clientX - rect.left, event.clientY - rect.top);
  };

  private onPointerLeave = (): void => {
    this.field.clearPointer();
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    // The empty tab's own actions open a note or a dialog at once, so the ring would never be seen.
    const target = event.target as Element | null;
    if (target?.closest?.(EMPTY_STATE_CONTROLS)) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    this.field.addRipple(x, event.clientY - rect.top);
    // Pan the drop toward where it landed; kept narrow so it stays subtle.
    this.onDrop(((x / Math.max(1, rect.width)) * 2 - 1) * 0.6);
  };
}

export default class CrispRipplePlugin extends Plugin {
  private ripples = new Map<View, EmptyTabRipple>();
  private rippleSettings: RippleSettings = normalizeSettings(undefined);
  private readonly sound = new DropSound();
  private dataWriteBlocked = false;
  private unloaded = false;
  private saveQueue: Promise<unknown> = Promise.resolve();
  /** A queued save that has not started yet; later changes ride along with it. */
  private pendingSave: Promise<boolean> | null = null;
  private saveErrorShown = false;
  private settingTab: RippleSettingTab | null = null;
  private readonly licenseController = new LicenseController({
    verify: (code, online) => this.checkLicense(code, online),
    discover: () => discoverVaultCrispLicenses(this.app, PLUGIN_ID),
    getCode: () => this.rippleSettings.licenseCode,
    persistCode: async (code) => {
      this.rippleSettings.licenseCode = code;
      return this.saveSettings();
    },
    onChange: () => {
      this.applyVisuals();
      this.settingTab?.display();
    },
  });

  /** Licence state as last verified; `licensed` also applies the expiry date at the moment of use. */
  get license(): LicenseResult {
    return this.licenseController.state;
  }

  get licensed(): boolean {
    return this.licenseController.licensed;
  }

  // Never overwrite a data.json that could not be read and could not be backed up either,
  // and never write from an instance that has already been unloaded.
  async saveData(data: unknown): Promise<void> {
    if (this.dataWriteBlocked || this.unloaded) return;
    await super.saveData(data);
  }

  async onload(): Promise<void> {
    const raw = await this.loadData();
    await this.protectUnreadableData(raw);
    this.rippleSettings = normalizeSettings(raw ?? {});
    // Startup stays local: only the embedded-key signature check, the online check runs later.
    await this.licenseController.loadLocal();

    // Paid features follow expiresAt even when Obsidian stays open past it.
    this.registerInterval(window.setInterval(() => this.licenseController.checkExpiry(), 60_000));

    this.settingTab = new RippleSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.addCommand({
      id: "toggle-sound",
      name: "Toggle water-drop sound",
      callback: async () => {
        if (!this.licensed) {
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
      // Obsidian queues this callback; the plugin may have been disabled or reloaded before it runs.
      if (this.unloaded) return;
      this.sync();
      void this.licenseController.refreshInBackground().catch((error) => {
        console.debug("Crisp Ripple background license check failed", error);
      });
    });
    this.registerEvent(this.app.workspace.on("layout-change", () => this.sync()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.sync()));
    this.registerEvent(this.app.workspace.on("css-change", () => this.applyVisuals()));
  }

  onunload(): void {
    this.unloaded = true;
    this.licenseController.dispose();
    for (const ripple of this.ripples.values()) ripple.destroy();
    this.ripples.clear();
    this.sound.dispose();
  }

  get options(): RippleSettings {
    return this.rippleSettings;
  }

  /**
   * Saves in order and reads data.json back, because Obsidian's saveData() swallows write errors.
   * Resolves false (after one notice) when the write could not be confirmed.
   */
  saveSettings(): Promise<boolean> {
    // A dragged slider fires many changes; one save that has not started yet covers them all.
    if (this.pendingSave) return this.pendingSave;
    const operation = this.saveQueue.then(async () => {
      this.pendingSave = null;
      // Taken when the write starts, so it includes every change made while this save waited.
      const snapshot = JSON.parse(JSON.stringify(this.rippleSettings)) as RippleSettings;
      if (this.unloaded || this.dataWriteBlocked) return false;
      await this.saveData(snapshot);
      try {
        await verifyDataWrite(this.app.vault.adapter, `${this.manifest.dir}/data.json`, snapshot);
        this.saveErrorShown = false;
        return true;
      } catch (error) {
        console.debug("Crisp Ripple settings save failed", error);
        if (!this.saveErrorShown) {
          this.saveErrorShown = true;
          new Notice("Crisp Ripple：设置没有写入磁盘，重启后会丢失。下次修改时会再试。");
        }
        return false;
      }
    });
    this.pendingSave = operation;
    this.saveQueue = operation.catch(() => false);
    return operation;
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
    if (!soundEnabled(this.rippleSettings, this.licensed)) return;
    this.sound.play({ pan: 0, seed: Math.random(), volume: this.rippleSettings.volume / 100 });
  }

  activate(code: string): Promise<ActivationOutcome> {
    return this.licenseController.activate(code);
  }

  clearLicense(): Promise<boolean> {
    return this.licenseController.clear();
  }

  private async checkLicense(code: string, online: boolean): Promise<LicenseResult> {
    const result = await verifyLicenseCode(code, PLUGIN_ID, online ? undefined : { online: false });
    return { valid: result.valid, payload: result.payload, reason: result.reason };
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

  private visuals = (): VisualSettings => effectiveVisuals(this.rippleSettings, this.licensed);

  private playDrop = (pan: number): void => {
    if (!soundEnabled(this.rippleSettings, this.licensed)) return;
    this.sound.play({ pan, seed: Math.random(), volume: this.rippleSettings.volume / 100 });
  };

  /** Shows or removes the field on every empty tab; not tied to the licence. */
  async setBackground(on: boolean): Promise<void> {
    this.rippleSettings.background = on;
    this.sync();
    await this.saveSettings();
  }

  private sync(): void {
    if (this.unloaded) return;
    const views = new Set<View>();
    // With the background off no tab gets a canvas, so nothing draws or listens.
    if (this.rippleSettings.background) {
      for (const leaf of this.app.workspace.getLeavesOfType("empty")) views.add(leaf.view);
    }
    for (const [view, ripple] of this.ripples) {
      if (!views.has(view) || !ripple.attached) {
        ripple.destroy();
        this.ripples.delete(view);
      }
    }
    for (const view of views) {
      if (this.ripples.has(view)) continue;
      // One tab that cannot host a canvas must not keep the others from getting theirs.
      try {
        this.ripples.set(view, new EmptyTabRipple(view, this.visuals, this.playDrop));
      } catch (error) {
        console.debug("Crisp Ripple could not decorate an empty tab", error);
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
    const licensed = this.plugin.licensed;

    this.renderLicense(containerEl);

    new Setting(containerEl).setName("背景").setHeading();
    new Setting(containerEl)
      .setName("显示字符背景")
      .setDesc("关闭后，空标签页恢复 Obsidian 原样，不再显示字符背景和波纹。")
      .addToggle((toggle) =>
        toggle.setValue(settings.background).onChange(async (value) => {
          await this.plugin.setBackground(value);
        }),
      );

    new Setting(containerEl).setName("声音").setHeading();
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
    if (!licensed) this.lockedNote(containerEl, "未激活时使用默认外观；调节形态、颜色、速度、浓淡和推开力度需要激活。");

    // Preview at once; the save reads data.json back and can lag behind a dragged slider.
    const save = async (): Promise<void> => {
      this.plugin.applyVisuals();
      await this.plugin.saveSettings();
    };

    new Setting(containerEl)
      .setName("形态")
      .setDesc("背景由字符组成，或由圆点组成。")
      .setDisabled(!licensed)
      .addDropdown((dropdown) =>
        dropdown
          .addOption("glyph", "字符")
          .addOption("dot", "圆点")
          .setValue(licensed ? settings.shape : DEFAULT_VISUALS.shape)
          .setDisabled(!licensed)
          .onChange(async (value) => {
            settings.shape = value as Shape;
            await save();
          }),
      );

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
    this.addPercentSlider("推开力度", "指针经过时把字符推开、点击时冲击波把字符推开的力度，0% 为不移动。", "push", licensed, save);

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
    if (this.plugin.licensed) {
      const payload = license.payload;
      const user = payload?.userName || "Crisp 用户";
      const expiry = payload?.expiresAt ? `到期时间：${String(payload.expiresAt).split("T")[0]}` : "永久授权";
      status.setDesc(`已激活（授权用户：${user} · ${expiry}）`);
      status.addButton((button) =>
        button
          .setButtonText("清除授权")
          .setWarning()
          .onClick(async () => {
            const saved = await this.plugin.clearLicense();
            this.licenseDraft = "";
            new Notice(
              saved ? "已清除授权信息" : "本次运行已清除授权，但没能写入设置文件：重启后授权会恢复。",
              saved ? undefined : 0,
            );
            this.display();
          }),
      );
    } else {
      status.setDesc(
        license.reason
          ? `未激活：${license.reason}`
          : "未激活。背景字符、指针推开和默认波纹可以直接使用；水滴音效和外观调节需要激活。",
      );
    }

    if (this.plugin.licensed) return;
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
              const { result, applied, saved } = await this.plugin.activate(code);
              if (!applied) return;
              if (!result.valid) {
                new Notice(`激活未通过：${result.reason || "未知原因"}`);
                return;
              }
              this.licenseDraft = "";
              new Notice(
                saved
                  ? `Crisp Ripple 激活成功，欢迎使用，${result.payload?.userName || "Crisp 用户"}`
                  : "授权验证通过，但没能写入设置文件：本次可以使用，重启后需要重新激活。",
                saved ? 4000 : 0,
              );
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
    card.createDiv({ cls: "crisp-ripple-about__description", text: "让空标签页泛起一圈字符波纹，指针经过时字符会被推开。" });
    const byline = card.createEl("p", { cls: "crisp-ripple-about__author" });
    byline.createSpan({ text: "作者：" });
    const link = byline.createEl("a", { cls: "crisp-ripple-about__author-link", text: "小红书 letschips", href: AUTHOR_URL });
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }

  private addPercentSlider(
    name: string,
    desc: string,
    key: "speed" | "strength" | "density" | "push",
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
