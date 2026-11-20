import { Controller, Inject } from '@nestjs/common';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService, @Inject('MAILER') private readonly mailer: unknown) {}
}
