

/**
 * G24: ResourceScheduler — resource-aware goal scheduling.
 *
 * Matches goals to available resources from fleetPools(). A goal that requires GPU
 * waits for GPU availability. Deferred goals are queued with reason 'waiting_for_resources'.
 */

interface ResourceRequirement {
  requires_gpu?: boolean;
  requires_cpu?: number;  // min CPU cores
  requires_mem_mb?: number;  // min memory in MB
}

interface ResourceAvailability {
  has_gpu: boolean;
  cpu_available: number;
  mem_available_mb: number;
}

export class ResourceScheduler {
  constructor() {}

  /**
   * Estimate resource requirements for a goal from its metadata.
   */
  estimateResources(goalMetadata: Record<string, unknown>): ResourceRequirement {
    return {
      requires_gpu: Boolean(goalMetadata.requires_gpu),
      requires_cpu: typeof goalMetadata.requires_cpu === 'number' ? goalMetadata.requires_cpu : 1,
      requires_mem_mb: typeof goalMetadata.requires_mem_mb === 'number' ? goalMetadata.requires_mem_mb : 512,
    };
  }

  /**
   * Check if resources are available for a goal.
   * In production, this would query fleetPools(). For now, it uses a simple heuristic.
   */
  checkAvailability(req: ResourceRequirement): ResourceAvailability {
    // In production: query SwarmStatusService.fleetPools() for actual resources.
    // For now: assume CPU and memory are always available; GPU depends on env.
    const hasGpu = process.env.FLEET_HAS_GPU === 'true' || !req.requires_gpu;
    return {
      has_gpu: hasGpu,
      cpu_available: 8, // simplified
      mem_available_mb: 16384, // simplified
    };
  }

  /**
   * Check if a goal can be scheduled given current resources.
   */
  canSchedule(goalMetadata: Record<string, unknown>): { canSchedule: boolean; reason: string } {
    const req = this.estimateResources(goalMetadata);
    const avail = this.checkAvailability(req);

    if (req.requires_gpu && !avail.has_gpu) {
      return { canSchedule: false, reason: 'waiting_for_resources: gpu not available' };
    }
    if (req.requires_cpu && req.requires_cpu > avail.cpu_available) {
      return { canSchedule: false, reason: 'waiting_for_resources: insufficient cpu' };
    }
    if (req.requires_mem_mb && req.requires_mem_mb > avail.mem_available_mb) {
      return { canSchedule: false, reason: 'waiting_for_resources: insufficient memory' };
    }
    return { canSchedule: true, reason: 'resources available' };
  }
}
