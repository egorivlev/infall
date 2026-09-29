//! Identifier newtypes.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! id_type {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        pub struct $name(pub Uuid);

        impl $name {
            /// A fresh random (v4) id.
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }
    };
}

id_type!(/// Identifies a Card, Frame or Connection.
    EntityId);
id_type!(/// Identifies a Member.
    MemberId);
id_type!(/// Identifies a Branch.
    BranchId);
id_type!(/// Identifies a single Change.
    ChangeId);
id_type!(/// Groups the Changes of one Restore or Merge.
    BatchId);
