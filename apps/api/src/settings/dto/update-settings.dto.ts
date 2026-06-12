import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'isSettingsMap', async: false })
class IsSettingsMapConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.entries(value).every(
        ([key, setting]) =>
          /^[a-z][a-z0-9_]{0,63}$/.test(key) &&
          typeof setting === 'string' &&
          setting.length <= 1000,
      )
    );
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a string map with snake_case keys up to 64 chars and string values up to 1000 chars`;
  }
}

function IsSettingsMap(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: IsSettingsMapConstraint,
    });
  };
}

export class UpdateSettingsDto {
  @IsSettingsMap()
  settings!: Record<string, string>;
}
