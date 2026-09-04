import { renderNativeSourceDoctorReport } from '../core/sourceDoctor/renderNativeSourceDoctorReport';
import type {
  NativeSourceDoctorRenderedReport,
  NativeSourceDoctorReport,
} from '../core/sourceDoctor/types';

export const RUN_NATIVE_SOURCE_DOCTOR_COMMAND = 'tokenGauge.runNativeSourceDoctor' as const;

export interface NativeSourceDoctorCommandResult {
  readonly commandId: typeof RUN_NATIVE_SOURCE_DOCTOR_COMMAND;
  readonly openedReport: boolean;
  readonly report: NativeSourceDoctorReport;
}

export interface NativeSourceDoctorCommandDeps {
  readonly buildReport: () => Promise<NativeSourceDoctorReport> | NativeSourceDoctorReport;
  readonly renderReport: (report: NativeSourceDoctorRenderedReport) => Promise<void>;
}

export async function runNativeSourceDoctor(
  deps: NativeSourceDoctorCommandDeps,
): Promise<NativeSourceDoctorCommandResult> {
  const report = await deps.buildReport();
  const rendered = renderNativeSourceDoctorReport(report);
  await deps.renderReport(rendered);
  return {
    commandId: RUN_NATIVE_SOURCE_DOCTOR_COMMAND,
    openedReport: true,
    report,
  };
}
