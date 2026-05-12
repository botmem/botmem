import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface AppleContact {
  id: string;
  displayName?: string;
  givenName?: string;
  familyName?: string;
  middleName?: string;
  nickname?: string;
  organization?: string;
  jobTitle?: string;
  birthday?: string;
  emails: string[];
  phones: string[];
  imageAvailable?: boolean;
}

const SWIFT_HELPER = String.raw`
import Contacts
import Foundation

struct ContactPayload: Codable {
  let id: String
  let displayName: String?
  let givenName: String?
  let familyName: String?
  let middleName: String?
  let nickname: String?
  let organization: String?
  let jobTitle: String?
  let birthday: String?
  let emails: [String]
  let phones: [String]
  let imageAvailable: Bool
}

let store = CNContactStore()
let keys: [CNKeyDescriptor] = [
  CNContactIdentifierKey as CNKeyDescriptor,
  CNContactGivenNameKey as CNKeyDescriptor,
  CNContactFamilyNameKey as CNKeyDescriptor,
  CNContactMiddleNameKey as CNKeyDescriptor,
  CNContactNicknameKey as CNKeyDescriptor,
  CNContactOrganizationNameKey as CNKeyDescriptor,
  CNContactJobTitleKey as CNKeyDescriptor,
  CNContactBirthdayKey as CNKeyDescriptor,
  CNContactEmailAddressesKey as CNKeyDescriptor,
  CNContactPhoneNumbersKey as CNKeyDescriptor,
  CNContactImageDataAvailableKey as CNKeyDescriptor
]

let semaphore = DispatchSemaphore(value: 0)
var granted = false
var authError: Error?
store.requestAccess(for: .contacts) { ok, error in
  granted = ok
  authError = error
  semaphore.signal()
}
semaphore.wait()

if !granted {
  let message = authError?.localizedDescription ?? "Contacts permission was denied"
  FileHandle.standardError.write(Data(message.utf8))
  exit(2)
}

func clean(_ value: String) -> String? {
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : trimmed
}

func birthdayString(_ date: DateComponents?) -> String? {
  guard let date else { return nil }
  var parts: [String] = []
  if let year = date.year { parts.append(String(format: "%04d", year)) }
  if let month = date.month { parts.append(String(format: "%02d", month)) }
  if let day = date.day { parts.append(String(format: "%02d", day)) }
  return parts.isEmpty ? nil : parts.joined(separator: "-")
}

let request = CNContactFetchRequest(keysToFetch: keys)
var contacts: [ContactPayload] = []

try store.enumerateContacts(with: request) { contact, _ in
  let names = [contact.givenName, contact.middleName, contact.familyName]
    .compactMap(clean)
    .joined(separator: " ")
  let displayName = clean(names) ?? clean(contact.nickname) ?? clean(contact.organizationName)
  contacts.append(ContactPayload(
    id: contact.identifier,
    displayName: displayName,
    givenName: clean(contact.givenName),
    familyName: clean(contact.familyName),
    middleName: clean(contact.middleName),
    nickname: clean(contact.nickname),
    organization: clean(contact.organizationName),
    jobTitle: clean(contact.jobTitle),
    birthday: birthdayString(contact.birthday),
    emails: contact.emailAddresses.compactMap { clean(String($0.value)) },
    phones: contact.phoneNumbers.compactMap { clean($0.value.stringValue) },
    imageAvailable: contact.imageDataAvailable
  ))
}

let data = try JSONEncoder().encode(contacts)
FileHandle.standardOutput.write(data)
`;

export async function listAppleContacts(): Promise<AppleContact[]> {
  const dir = await mkdir(join(tmpdir(), `botmem-apple-contacts-${process.pid}`), {
    recursive: true,
  }).then(() => join(tmpdir(), `botmem-apple-contacts-${process.pid}`));
  const helperPath = join(dir, 'contacts-helper.swift');
  await writeFile(helperPath, SWIFT_HELPER, 'utf8');
  try {
    const stdout = await runSwift(helperPath);
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as AppleContact[]) : [];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runSwift(helperPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('xcrun', ['swift', helperPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `Apple Contacts helper exited with code ${code}`));
    });
  });
}
