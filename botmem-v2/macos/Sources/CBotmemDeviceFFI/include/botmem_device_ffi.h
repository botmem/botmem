#ifndef BOTMEM_DEVICE_FFI_H
#define BOTMEM_DEVICE_FFI_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

const char *botmem_device_ffi_version(void);
char *botmem_device_probe(const char *source);
char *botmem_device_sync(const char *source, const char *store_root, bool reconcile);
void botmem_device_string_free(char *value);

#ifdef __cplusplus
}
#endif

#endif
