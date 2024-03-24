# test_email_case_sensitivity.py
from phonebuddies.DatabaseConnector import DatabaseConnector

def test_email_case_insensitivity():
    db_connector = DatabaseConnector.get_instance()

    # Assuming 'test@example.com' is known to exist in your buddy map,
    # the test checks both lowercase and uppercase variants.
    assert db_connector.is_email_in_database('test@example.com') == True
    assert db_connector.is_email_in_database('TEST@example.com') == True
