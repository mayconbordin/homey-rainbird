import Homey from 'homey';
import { Zone } from './models/zone';

const ZONE_CAPABILITY_PREFIX = 'onoff.zone';
const STOP_CAPABILITY = 'button.stop_irrigation';

const REFRESH_RATE_SECONDS = 30;
const STATUS_WATCHDOG_MS = 2 * 60 * 1000;

class RainbirdDevice extends Homey.Device {
    rainbirdService: any | undefined;
    zones: Zone[] = [];
    endTime: Date | undefined = undefined;
    cancelLoop: boolean = true;
    isActiveCard!: Homey.FlowCardTriggerDevice;
    enableQueueing: boolean = false;
    timeoutId: NodeJS.Timeout | undefined;
    rainDelayDays: number = 0;
    lastRainDelayCheck: number = 0;
    zoneSwitchListeners = new Set<string>();
    lastStatusAt: number = 0;
    statusWatchdog: NodeJS.Timeout | undefined;

    /**
     * A zone started by a controller schedule can be reported as running without a
     * remaining time (models the library only partly supports), which isActive() misses.
     */
    zoneIsOn = (zone: number): boolean => {
        return Boolean(this.rainbirdService?.isActive(zone) || this.rainbirdService?.isInUse(zone));
    };

    getCurrentZoneId = (): number | undefined => {
        const zones = this.rainbirdService?.zones;

        for (const zone of zones ?? []) {
            if (this.zoneIsOn(zone)) {
                return zone;
            }
        }

        return undefined;
    };

    async updateRainSetPoint() {
        const rainSetPointReached = this.rainbirdService.rainSetPointReached ?? false;

        if (this.getCapabilityValue('rain_set_point_reached') !== rainSetPointReached) {
            const trigger = this.homey.flow.getDeviceTriggerCard('rain_set_point_changed');
            await trigger.trigger(this);

            if (rainSetPointReached) {
                await this.homey.flow.getDeviceTriggerCard('rain_set_point_reached').trigger(this);
            }
        }

        await this.setCapabilityValue('rain_set_point_reached', rainSetPointReached);
    }

    /**
     * The controller is polled every 30s for zone status; the rain delay changes far less often
     * and costs an extra round trip, so it is only re-read every 5 minutes (or on demand).
     */
    async updateRainDelay(force: boolean = false) {
        if (!this.rainbirdService) {
            return;
        }

        if (!force && Date.now() - this.lastRainDelayCheck < 5 * 60 * 1000) {
            return;
        }
        this.lastRainDelayCheck = Date.now();

        const days = (await this.rainbirdService.getIrrigationDelay()) ?? 0;

        if (days !== this.rainDelayDays) {
            this.rainDelayDays = days;
            await this.homey.flow.getDeviceTriggerCard('rain_delay_changed').trigger(this, { days });
        }

        await this.setCapabilityValue('rain_delay_days', days);
    }

    async getCurrentStatus(initial: boolean = false) {
        if (!this.rainbirdService) {
            return;
        }

        const isInUse = this.rainbirdService.isInUse() ?? false;
        const currentZoneId = this.getCurrentZoneId();

        this.log('Getting status', isInUse, currentZoneId, this.getCapabilityValue('is_active'));

        if (!initial && isInUse !== this.getCapabilityValue('is_active')) {
            const card = isInUse ? 'turns_on' : 'turns_off';

            const trigger = this.homey.flow.getDeviceTriggerCard(card);
            await trigger.trigger(this);
        }

        await this.setCapabilityValue('is_active', isInUse);
        await this.updateZoneSwitches();

        await this.updateRainSetPoint();
        await this.updateRainDelay(initial).catch((e) => this.error('Could not read rain delay', e));

        if (currentZoneId) {
            const zone = this.zones.find((z) => z.index === currentZoneId);
            if (zone) {
                await this.setCapabilityValue('active_zone', zone.name);
            } else {
                await this.setCapabilityValue('active_zone', 'Unknown');
            }

            const duration = this.rainbirdService?.remainingDuration(currentZoneId) ?? 0;

            if (duration) {
                const endDate = new Date(Date.now() + 1000 * duration);
                this.endTime = endDate;
                if (this.cancelLoop) {
                    this.cancelLoop = false;
                    await this.updateTime();
                }
            } else {
                await this.setCapabilityValue('zone_time_left', '-');
                this.cancelLoop = true;
            }
        } else {
            this.endTime = undefined;
            this.cancelLoop = true;
            await this.setCapabilityValue('active_zone', 'None');
            await this.setCapabilityValue('zone_time_left', '-');
        }
    }

    async instantiateController() {
        const { zones, host, password, debug, enableQueueing, defaultIrrigationTime, zonesAvailable } = this.getSettings();

        this.zones = zones;
        // Was read from settings but never assigned, so queueing was always off and
        // every new zone start cancelled the running one.
        this.enableQueueing = enableQueueing === true;
        this.log('Getting configured zones', this.zones, 'queueing', this.enableQueueing);

        // Before init(), so the switches are there even while the controller is unreachable.
        // A failure here must not make the whole device unavailable.
        await this.syncZoneCapabilities().catch((e) => this.error('Could not set up the zone switches', e));

        // eslint-disable-next-line node/no-unsupported-features/es-syntax
        const serviceType = await import('rainbird/dist/RainBird/RainBirdService.js');
        this.log('Imported RainBirdService');

        // Your code that uses RainBirdService goes here
        const { RainBirdService } = serviceType;

        this.rainbirdService = new RainBirdService({
            address: host,
            password,
            syncTime: true,
            showRequestResponse: debug ?? false,
            refreshRate: REFRESH_RATE_SECONDS,
        });

        this.log('RainbirdService created');

        // Debug is the library's per-request chatter; the rest is worth having in the app log.
        this.rainbirdService.on('log', ({ level, message }: { level: string; message: string }) => {
            if (level !== 'debug') {
                this.log(`[rainbird ${level}] ${message}`);
            }
        });

        const metadata = await this.rainbirdService?.init();
        this.lastStatusAt = Date.now();

        if (enableQueueing === 'on') {
            await this.setSettings({ enableQueueing: false });
        }

        if (typeof defaultIrrigationTime === 'string') {
            await this.setSettings({ defaultIrrigationTime: 60 });
        }

        if (!zonesAvailable && metadata.zones) {
            await this.setSettings({
                zonesAvailable: metadata.zones.length,
            });
        }

        await this.getCurrentStatus(true);

        this.rainbirdService.on('status', () => {
            this.lastStatusAt = Date.now();
            this.getCurrentStatus().catch((e) => this.error(e));
        });

        this.startStatusWatchdog();
    }

    /**
     * The library stops polling for good after one failed status request: the failed read
     * returns undefined, updateStatus() throws, and performStatusRefresh() swallows the error
     * without re-arming its timer. Kick it again whenever status goes stale.
     */
    startStatusWatchdog() {
        if (this.statusWatchdog) {
            this.homey.clearInterval(this.statusWatchdog);
        }

        this.statusWatchdog = this.homey.setInterval(() => {
            const staleFor = Date.now() - this.lastStatusAt;
            if (this.rainbirdService && staleFor > STATUS_WATCHDOG_MS) {
                this.log(`No controller status for ${Math.round(staleFor / 1000)}s, restarting status polling`);
                this.rainbirdService.refreshStatus();
            }
        }, STATUS_WATCHDOG_MS);

        this.rainbirdService.on('rain_sensor_state', async () => {
            this.log('Rain sensor state changed');

            await this.updateRainSetPoint();
        });
    }

    /**
     * onInit is called when the device is initialized.
     */
    async onInit() {
        this.log('RainbirdDevice has been initialized');

        if (!this.hasCapability('rain_set_point_reached')) {
            await this.addCapability('rain_set_point_reached');
        }

        if (!this.hasCapability('rain_delay_days')) {
            await this.addCapability('rain_delay_days');
        }

        // Added at runtime rather than in the manifest: Homey refuses setCapabilityOptions
        // for capabilities whose options come from the manifest.
        if (!this.hasCapability(STOP_CAPABILITY)) {
            await this.addCapability(STOP_CAPABILITY);
            await this.setCapabilityOptions(STOP_CAPABILITY, {
                title: { en: 'Stop irrigation', nl: 'Irrigatie stoppen' },
            });
        }
        this.registerCapabilityListener(STOP_CAPABILITY, async () => {
            this.log('Stop irrigation button pressed');
            await this.stopIrrigation();
            await this.updateZoneSwitches();
        });

        await this.instantiateController();
    }

    /**
     * onAdded is called when the user adds the device, called just after pairing.
     */
    async onAdded() {
        this.log('RainbirdDevice has been added');
    }

    /**
     * onSettings is called when the user updates the device's settings.
     * @param {object} event the onSettings event data
     * @param {object} event.oldSettings The old settings object
     * @param {object} event.newSettings The new settings object
     * @param {string[]} event.changedKeys An array of keys changed since the previous version
     * @returns {Promise<string|void>} return a custom message that will be displayed
     */
    async onSettings({
        oldSettings,
        newSettings,
        changedKeys,
    }: {
        oldSettings: {
            [key: string]: boolean | string | number | undefined | null;
        };
        newSettings: { [key: string]: boolean | string | number | undefined | null };
        changedKeys: string[];
    }): Promise<string | void> {
        this.log('RainbirdDevice settings where changed');

        if (this.timeoutId) {
            this.homey.clearTimeout(this.timeoutId);
        }

        this.rainbirdService?.deactivateAllZones();

        await this.rainbirdService?.stopIrrigation();
        await this.instantiateController();
    }

    /**
     * onRenamed is called when the user updates the device's name.
     * This method can be used this to synchronise the name to the device.
     * @param {string} name The new name
     */
    async onRenamed(name: string) {
        this.log('RainbirdDevice was renamed');
    }

    /**
     * onDeleted is called when the user deleted the device.
     */
    async onDeleted() {
        this.log('RainbirdDevice has been deleted');

        if (this.statusWatchdog) {
            this.homey.clearInterval(this.statusWatchdog);
        }

        this.cancelLoop = true;
        if (this.timeoutId) {
            this.homey.clearTimeout(this.timeoutId);
        }

        this.rainbirdService?.deactivateAllZones();
        await this.rainbirdService?.stopIrrigation();
    }

    /**
     * One onoff.zone<index> switch per named zone, titled with the zone name. Zones are
     * configured per device (pairing, repair), so the switches can't live in the manifest.
     */
    async syncZoneCapabilities() {
        const zones = this.zones ?? [];
        const wanted = new Map(zones.map((zone) => [`${ZONE_CAPABILITY_PREFIX}${zone.index}`, zone]));

        for (const capability of this.getCapabilities()) {
            if (capability.startsWith(ZONE_CAPABILITY_PREFIX) && !wanted.has(capability)) {
                await this.removeCapability(capability);
            }
        }

        for (const [capability, zone] of wanted) {
            if (!this.hasCapability(capability)) {
                await this.addCapability(capability);
            }

            // setCapabilityOptions is expensive, only call it when the name changed.
            if (this.zoneSwitchTitle(capability) !== zone.name) {
                await this.setCapabilityOptions(capability, {
                    title: { en: zone.name },
                    uiQuickAction: false,
                });
            }

            if (!this.zoneSwitchListeners.has(capability)) {
                this.registerCapabilityListener(capability, async (value: boolean) => {
                    await this.onZoneSwitch(capability, value);
                });
                this.zoneSwitchListeners.add(capability);
            }
        }
    }

    zoneSwitchTitle(capability: string): string | undefined {
        try {
            return this.getCapabilityOptions(capability)?.title?.en;
        } catch (error) {
            // Homey throws "Invalid Capability" when reading the options of a capability
            // that was added during this same onInit.
            return undefined;
        }
    }

    onZoneSwitch = async (capability: string, value: boolean) => {
        const index = Number(capability.substring(ZONE_CAPABILITY_PREFIX.length));
        const zone = this.zones.find((z) => z.index === index);

        if (!zone) {
            throw new Error(`Zone ${index} is not configured`);
        }
        if (!this.rainbirdService) {
            throw new Error('Not connected to the Rain Bird controller');
        }

        if (value) {
            await this.startZone({ zone });
        } else {
            await this.stopZone({ zone });
        }

        // Without queueing, starting a zone stops the others; reflect that right away
        // instead of waiting for the next status poll.
        await this.updateZoneSwitches(capability);
    };

    async updateZoneSwitches(skip?: string) {
        const available: number[] = this.rainbirdService?.zones ?? [];

        for (const zone of this.zones ?? []) {
            const capability = `${ZONE_CAPABILITY_PREFIX}${zone.index}`;
            if (capability === skip || !this.hasCapability(capability) || !available.includes(zone.index)) {
                continue;
            }

            const active = this.zoneIsOn(zone.index);
            if (this.getCapabilityValue(capability) !== active) {
                await this.setCapabilityValue(capability, active);
            }
        }
    }

    /**
     * Called by the driver after the zone names were edited in the repair view, which saves
     * them with setSettings() and so never reaches onSettings().
     */
    public updateZones = async () => {
        this.zones = this.getSetting('zones') ?? [];
        await this.syncZoneCapabilities();
        await this.updateZoneSwitches();
    };

    updateTime = async () => {
        const now = Date.now();

        if (this.endTime) {
            if (now > this.endTime.getTime()) {
                await this.setCapabilityValue('zone_time_left', '-');
                this.cancelLoop = true;
            } else {
                const remaining = (this.endTime.getTime() - now) / 1000;
                await this.setCapabilityValue('zone_time_left', this.formatTime(remaining));
            }
        } else {
            await this.setCapabilityValue('zone_time_left', '-');
        }

        if (!this.cancelLoop) {
            this.timeoutId = await this.homey.setTimeout(this.updateTime.bind(this), 1000 - (now % 1000));
        }
    };

    public rainbirdIsActive = async (): Promise<boolean> => {
        return this.rainbirdService?.isInUse();
    };

    public rainSetPointActive = async (): Promise<boolean> => {
        return this.rainbirdService?.rainSetPointReached ?? false;
    };

    public zoneIsActive = async (args: any) => {
        if (args.zone) {
            return this.rainbirdService?.isInUse(args.zone.index);
        }
        return false;
    };

    public startZoneWithTime = async (args: any) => {
        const { zone, minutes } = args;

        if (zone && minutes) {
            if (!this.enableQueueing) {
                this.log('No queueing, disabling active zones before starting new one');
                this.rainbirdService?.deactivateAllZones();
                await this.rainbirdService?.stopIrrigation();
                this.log(`Starting zone ${zone.name} (${zone.index}) for ${minutes} minutes`);
            } else {
                this.log(`Queueing zone ${zone.name} (${zone.index}) for ${minutes} minutes`);
            }

            this.rainbirdService?.activateZone(zone.index, minutes * 60);
        }
    };

    public startZone = async (args: any) => {
        const { zone } = args;

        const minutes = this.getSetting('defaultIrrigationTime');

        if (zone) {
            if (!this.enableQueueing) {
                this.log('No queueing, disabling active zones before starting new one');
                this.rainbirdService?.deactivateAllZones();
                await this.rainbirdService?.stopIrrigation();
                this.log(`Starting zone ${zone.name} (${zone.index}) for ${minutes} minutes`);
            } else {
                this.log(`Queueing zone ${zone.name} (${zone.index}) for ${minutes} minutes`);
            }

            this.rainbirdService?.activateZone(zone.index, minutes * 60);
        }
    };

    public stopZone = async (args: any) => {
        const { zone } = args;

        if (zone) {
            this.log(`Stopping zone ${zone.name}`);

            this.rainbirdService?.deactivateZone(zone.index).catch((e) => this.error(e));
        }
    };

    public setRainDelay = async (args: any) => {
        const days = Number(args.days);

        this.log(`Setting rain delay to ${days} days`);

        await this.rainbirdService?.setIrrigationDelay(days);
        await this.updateRainDelay(true);
    };

    public rainDelayActive = async (): Promise<boolean> => {
        await this.updateRainDelay(true);
        return this.rainDelayDays > 0;
    };

    public startProgram = async (args: any) => {
        const { program } = args;

        this.log(`Starting program ${program}`);

        await this.rainbirdService?.startProgram(program);
    };

    public stopIrrigation = async () => {
        this.rainbirdService?.deactivateAllZones();
        this.rainbirdService?.stopIrrigation().catch((e) => this.error(e));
    };

    private formatTime(seconds?: number): string {
        if (seconds === undefined) {
            return '-';
        }
        const date = new Date(seconds * 1000);
        return date.toISOString().substring(11, 19);
    }
}

module.exports = RainbirdDevice;
