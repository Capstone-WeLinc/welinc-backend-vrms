import { IsISO8601, IsUUID, ValidateIf } from 'class-validator';

// Spec 0016, AC-21: PATCH /vrms/vehicles/:id
export class UpdateVehicleDto {
  // null clears the type
  @ValidateIf((o: UpdateVehicleDto) => o.vehicleTypeId !== null)
  @IsUUID()
  vehicleTypeId: string | null;

  // Required, so a truck changed by a create or another Admin answers 409
  @IsISO8601()
  updatedAt: string;
}
