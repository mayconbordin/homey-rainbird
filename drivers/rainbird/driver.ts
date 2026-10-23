import Homey from 'homey';
import { PairSession } from 'homey/lib/Driver';

import { FormResult } from './models/form-result';
import { Zone } from './models/zone';
import { probeController } from './probe';

interface PairResult {
    success: boolean;
    model?: string;
    zones?: number[];
}

interface PairData {
    host: string;
    password: string;
    enableQueueing: boolean;
    defaultIrrigationTime: number;
}

class RainBirdDriver extends Homey.Driver {
    pairData: PairData | undefined;
    pairResult: PairResult | undefined;
    zoneNames: Record<number, string> = {};

    /**
     * onInit is called when the driver is initialized.
     */
    onInit = async () => {
        this.log('Rainbird has been initialized');

        this.homey.flow.getActionCard('start_zone_X_minutes').registerRunListener(async (args) => {
            this.log('start_zone_X_minutes');
            await args.device.startZoneWithTime(args);
        });

        this.homey.flow.getActionCard('start_zone').registerRunListener(async (args) => {
            this.log('start_zone');
            await args.device.startZone(args);
        });

        this.homey.flow.getActionCard('stop_zone').registerRunListener(async (args) => {
            this.log('stop_zone');
            await args.device.stopZone(args);
        });

        this.homey.flow.getActionCard('stop_irrigation').registerRunListener(async (args) => {
            this.log('stop_irrigation');
            await args.device.stopIrrigation(args);
        });

        this.homey.flow.getConditionCard('zone_is_active').registerRunListener(async (args) => {
            this.log('zone_is_active');
            return args.device.zoneIsActive(args);
        });

        this.homey.flow.getConditionCard('rainbird_is_active').registerRunListener(async (args) => {
            return args.device.rainbirdIsActive();
        });

        this.homey.flow.getConditionCard('rain_set_point_active').registerRunListener(async (args) => {
            return args.device.rainSetPointActive();
        });

        this.homey.flow.getActionCard('set_rain_delay').registerRunListener(async (args) => {
            this.log('set_rain_delay');
            await args.device.setRainDelay(args);
        });

        this.homey.flow.getActionCard('start_program').registerRunListener(async (args) => {
            this.log('start_program');
            await args.device.startProgram(args);
        });

        this.homey.flow.getConditionCard('rain_delay_active').registerRunListener(async (args) => {
            return args.device.rainDelayActive();
        });
    };

    connect = async (data: PairData): Promise<PairResult> => {
        await probeController(data.host, data.password);

        // eslint-disable-next-line node/no-unsupported-features/es-syntax
        const serviceType = await import('rainbird/dist/RainBird/RainBirdService.js');
        const { RainBirdService } = serviceType;

        const service = new RainBirdService({
            address: data.host,
            password: data.password,
            syncTime: false,
            showRequestResponse: true,
            refreshRate: 0,
        });

        const metadata = await service.init();

        if (metadata.model === undefined || metadata.zones === undefined) {
            return {
                success: false,
            };
        }

        return {
            success: true,
            zones: metadata.zones,
            model: metadata.model,
        };
    };

    createZonesFromData = (data: Record<number, string>): Zone[] => {
        const result: Zone[] = [];
        for (const key of Object.keys(data)) {
            if (this.zoneNames[key] !== undefined && this.zoneNames[key] !== '') {
                result.push({
                    index: Number(key),
                    name: this.zoneNames[key],
                });
            }
        }
        return result;
    };

    onPair = async (session: PairSession) => {
        session.setHandler('form_complete', async (data) => {
            if (data.host && data.password) {
                this.pairData = data as PairData;

                try {
                    this.pairResult = await this.connect(this.pairData as PairData);

                    if (!this.pairResult.success) {
                        return this.pairResult;
                    }
                    await session.nextView();
                    return this.pairResult;
                } catch (error) {
                    this.error('Error connecting to Rainbird', error);
                    return {
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                    };
                }
            }
            return {
                success: false,
            };
        });

        session.setHandler('update_zone_names', async (data) => {
            this.zoneNames = data;
        });

        session.setHandler('list_devices', async () => {
            if (this.pairData && this.pairResult && this.pairResult.success) {
                const zones = this.createZonesFromData(this.zoneNames);

                this.log('pairData', JSON.stringify(this.pairData));

                const name = this.pairResult.model ?? 'Unknown model';
                const deviceId = process.env.DEBUG ? `${name} debug` : `${name}`;

                return [
                    {
                        name: deviceId,
                        data: {
                            id: `rainbird_${this.pairData.host}`,
                        },
                        settings: {
                            host: this.pairData.host,
                            password: this.pairData.password,
                            defaultIrrigationTime: Number(this.pairData.defaultIrrigationTime),
                            enableQueueing: this.pairData.enableQueueing,
                            zones,
                        },
                    },
                ];
            }
            return [];
        });

        session.setHandler('showView', async (view) => {
            if (view === 'zones') {
                await session.emit('pairing_data', this.pairResult);
            }
        });
    };

    onRepair = async (session: PairSession, device: Homey.Device) => {
        session.setHandler('showView', async (view) => {
            if (view === 'zone_names') {
                await this.emitZoneMetadata(session, device);
            }
        });

        session.setHandler('zone_name_update', async (data) => {
            return this.zoneNameUpdate(data, device);
        });
    };

    emitZoneMetadata = async (session: PairSession, device: Homey.Device) => {
        const { zones, zonesAvailable } = await device.getSettings();
        await session.emit('metadata', {
            zones,
            zonesAvailable,
        });
    };

    zoneNameUpdate = async (data: Record<number, string>, device: Homey.Device): Promise<FormResult> => {
        this.zoneNames = data;

        try {
            const zones = this.createZonesFromData(this.zoneNames);

            await device.setSettings({
                zones,
            });

            return {
                success: true,
            };
        } catch (error) {
            return {
                success: false,
            };
        }
    };

    testMethod = (): string => {
        return 'test';
    };
}

module.exports = RainBirdDriver;
