Project Name: Identity Fabric
Project Creator & Designer: John Lake
Project Collaborator: Chinedu Osuwa

Project Description:
- Identity Fabric is a Database that agonostically polls and retrieves all possible user attributes that exist across every single application in the organization with complete source tracking, and stores it into a single MongoDB Document Database Object.
- The attribute name, and value will be pulled as raw data with no friendly name applied
- This mongodb database is split into two different Collections, Internal and External Respectively
    - Internal:
        - This Collection will store all TUHS True Users across the organization.This is sourced from an AD Sync Python script in this         directory, and specifically from the "All Current True Users" group that exists in Active Directory

    - External:
        - This Collection will store all External Physician Identities. These are sourced from Lexus Nexus.

- Sailpoint will utilize this database as a source to create accounts based on Identities in TUHS applications for autoprovisioning

